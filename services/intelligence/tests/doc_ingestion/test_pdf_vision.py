"""Real PDFium rendering and bounded model orchestration. No paid API calls."""

import asyncio
import hashlib
import multiprocessing
import time
from io import BytesIO
from types import SimpleNamespace

import pytest
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    DictionaryObject,
    NameObject,
    DecodedStreamObject,
    NumberObject,
)
from test_parsers import pdf, input_for, Vision
from aiqa_intelligence.context import RequestContext
from aiqa_intelligence.doc_ingestion.runner import ParseRunner
from aiqa_intelligence.doc_ingestion.pdf_images import render_page
from aiqa_intelligence.doc_ingestion.service import DocumentParser
from aiqa_intelligence.errors import ServiceError
from aiqa_intelligence.storage import ArtifactReader


def multi_image_page():
    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=100)
    images = DictionaryObject()
    for name, color in [("/Left", b"\xff\x00\x00"), ("/Right", b"\x00\x00\xff")]:
        image = DecodedStreamObject()
        image.set_data(color * 4)
        image.update(
            {
                NameObject(k): v
                for k, v in {
                    "/Type": NameObject("/XObject"),
                    "/Subtype": NameObject("/Image"),
                    "/Width": NumberObject(2),
                    "/Height": NumberObject(2),
                    "/ColorSpace": NameObject("/DeviceRGB"),
                    "/BitsPerComponent": NumberObject(8),
                }.items()
            }
        )
        images[NameObject(name)] = writer._add_object(image)
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/XObject"): images})
    stream = DecodedStreamObject()
    # Two distinct images, separated by white space.
    stream.set_data(
        b"q 100 0 0 100 0 0 cm /Left Do Q q 100 0 0 100 200 0 cm /Right Do Q"
    )
    page[NameObject("/Contents")] = writer._add_object(stream)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def test_full_page_contains_both_images_and_whole_layout():
    image = Image.open(BytesIO(render_page(multi_image_page(), 1))).convert("RGB")
    assert image.size == (600, 200)
    assert image.getpixel((50, 100)) == (255, 0, 0)
    assert image.getpixel((300, 100)) == (255, 255, 255)
    assert image.getpixel((550, 100)) == (0, 0, 255)


def test_render_size_and_invalid_page_are_bounded():
    writer = PdfWriter()
    writer.add_blank_page(width=14000, height=14000)
    output = BytesIO()
    writer.write(output)
    image = Image.open(BytesIO(render_page(output.getvalue(), 1)))
    assert max(image.size) <= 2048
    with pytest.raises(ValueError):
        render_page(output.getvalue(), 2)
    writer = PdfWriter()
    writer.add_blank_page(width=15000, height=15000)
    output = BytesIO()
    writer.write(output)
    with pytest.raises(ValueError, match="尺寸"):
        render_page(output.getvalue(), 1)


async def parse(tmp_path, data, gateway, parser=None):
    input = input_for(tmp_path, data, "PDF_TEXT")
    ctx = RequestContext("r", "mock", ArtifactReader(tmp_path), gateway)
    return (await (parser or DocumentParser()).parse_document(input, ctx)).model_dump()


def test_model_receives_actual_entire_page_even_with_text_layer(tmp_path):
    writer = PdfWriter()
    page = writer.add_page(PdfReader(BytesIO(multi_image_page())).pages[0])
    page.mediabox.upper_right = (300, 200)
    page.merge_page(PdfReader(BytesIO(pdf(["VisibleText"]))).pages[0])
    output = BytesIO()
    writer.write(output)
    assert (
        "VisibleText" in PdfReader(BytesIO(output.getvalue())).pages[0].extract_text()
    )

    class Inspect:
        async def describe_image_bytes(self, request, data):
            image = Image.open(BytesIO(data)).convert("RGB")
            assert image.size == (600, 400)
            assert image.getpixel((50, 300)) == (255, 0, 0)
            assert image.getpixel((550, 300)) == (0, 0, 255)
            # Text layer and BOTH images are in the same model image.
            assert any(
                max(pixel) < 50 for pixel in image.crop((0, 0, 600, 200)).getdata()
            )
            assert "sha256=" in request.imageStorageKey
            return SimpleNamespace(
                parsedJson={
                    "text": "VisibleText Left ,} Right 500000",
                    "complete": True,
                },
                outcome="SUCCESS",
            )

    result = asyncio.run(parse(tmp_path, output.getvalue(), Inspect()))
    assert result["blocks"][0]["text"] == "VisibleText Left ,} Right 500000"
    assert result["coverageSummary"]["lowSpans"] == 1


def test_page_budget_marks_remaining_pages_without_more_model_calls(
    tmp_path, monkeypatch
):
    monkeypatch.setattr("aiqa_intelligence.doc_ingestion.service.MAX_VISION_PAGES", 1)
    gateway = Vision({"text": "First", "complete": True})
    result = asyncio.run(parse(tmp_path, pdf(["First", "Second"]), gateway))
    assert gateway.calls == 1
    assert result["coverageSummary"]["unparsedSpans"] == 1
    assert any(b["text"].strip() == "Second" for b in result["blocks"])
    assert any("调用预算" in w for w in result["warnings"])


def test_partial_model_output_retains_text_and_explicit_omission(tmp_path):
    result = asyncio.run(
        parse(tmp_path, pdf([None]), Vision({"text": "Some", "complete": False}))
    )
    assert result["parseStatus"] == "PARSED"
    assert result["coverageSummary"]["unparsedSpans"] == 1
    assert result["coverageSummary"]["lowSpans"] == 1


def test_visual_output_obeys_document_character_budget(tmp_path, monkeypatch):
    monkeypatch.setattr("aiqa_intelligence.doc_ingestion.bundle.MAX_TEXT_CHARS", 20)
    result = asyncio.run(
        parse(tmp_path, pdf([None, None]), Vision({"text": "x" * 15, "complete": True}))
    )
    assert result["parseStatus"] == "FAILED"
    assert sum(len(b["text"]) for b in result["blocks"]) <= 20


@pytest.mark.parametrize(
    "code", ["MODEL_NOT_CONFIGURED", "MODEL_TIMEOUT", "DEPENDENCY_UNAVAILABLE"]
)
def test_pdf_operational_errors_are_not_partial_success(tmp_path, code):
    with pytest.raises(ServiceError) as error:
        asyncio.run(
            parse(tmp_path, pdf([None]), Vision(None, ServiceError(code, "test")))
        )
    assert error.value.code == code


def _slow_render(sender, data, page):
    try:
        time.sleep(30)
        sender.send({"image": b"unused"})
    finally:
        sender.close()


def test_render_cancel_kills_child_and_keeps_event_loop_responsive(monkeypatch):
    monkeypatch.setattr(
        "aiqa_intelligence.doc_ingestion.runner._render_child", _slow_render
    )
    before = {p.pid for p in multiprocessing.active_children()}

    async def run():
        runner = ParseRunner()
        task = asyncio.create_task(runner.render(b"unused", 1))
        ticks = 0
        for _ in range(10):
            await asyncio.sleep(0.02)
            ticks += 1
        assert ticks == 10 and not task.done()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not ({p.pid for p in multiprocessing.active_children()} - before)
        assert (await runner.run(b"ok", "doc", "TXT"))["parseStatus"] == "PARSED"

    asyncio.run(run())


def test_document_deadline_terminates_rendering(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "aiqa_intelligence.doc_ingestion.runner._render_child", _slow_render
    )
    monkeypatch.setattr(
        "aiqa_intelligence.doc_ingestion.service.DOCUMENT_TIMEOUT_SECONDS", 0.5
    )
    before = {p.pid for p in multiprocessing.active_children()}
    started = time.monotonic()
    with pytest.raises(ServiceError) as error:
        asyncio.run(parse(tmp_path, pdf([None]), Vision(None)))
    assert error.value.code == "MODEL_TIMEOUT"
    assert time.monotonic() - started < 3
    assert not ({p.pid for p in multiprocessing.active_children()} - before)


def test_slow_model_is_cancelled_by_document_deadline(tmp_path, monkeypatch):
    # Isolate the model deadline from child startup speed on a loaded CI host.
    from aiqa_intelligence.doc_ingestion.runner import parse_bytes

    monkeypatch.setattr(
        "aiqa_intelligence.doc_ingestion.service.DOCUMENT_TIMEOUT_SECONDS", 0.1
    )

    class ImmediateRunner:
        async def run(self, data, document_id, format):
            return parse_bytes(data, document_id, format)

        async def render(self, data, page):
            return b"test-model-input"

    class Slow:
        cancelled = False

        async def describe_image_bytes(self, request, data):
            try:
                await asyncio.sleep(30)
            finally:
                self.cancelled = True

    gateway = Slow()
    parser = DocumentParser()
    parser.runner = ImmediateRunner()
    with pytest.raises(ServiceError) as error:
        asyncio.run(parse(tmp_path, pdf([None]), gateway, parser))
    assert error.value.code == "MODEL_TIMEOUT"
    assert gateway.cancelled

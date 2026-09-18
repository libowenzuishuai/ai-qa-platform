"""Bound CPU parsing to two child processes; cancellation kills the actual work."""

import asyncio
import multiprocessing
from .bundle import Bundle
from ..errors import ServiceError


def parse_bytes(data: bytes, document_id: str, format: str) -> dict:
    from .text import parse_text
    from .binary import parse_docx, parse_pdf, verify_image

    bundle = Bundle(document_id, format)
    status = None
    try:
        if format in {"MARKDOWN", "TXT"}:
            parse_text(data, bundle)
        elif format == "DOCX":
            parse_docx(data, bundle)
        elif format in {"PDF_TEXT", "PDF_SCANNED"}:
            status = parse_pdf(data, bundle)
        elif format in {"PNG", "JPEG"}:
            verify_image(data, format)
            # Image bytes validated here; vision is asynchronous in the parent.
            status = "NEEDS_OCR"
        else:
            raise ValueError("不支持的格式")
    except Exception as error:
        # A partial parse must never look like a successful complete document.
        from .bundle import ParseLimit

        bundle.warn(
            str(error)
            if isinstance(error, ParseLimit)
            else "文件格式无效、损坏、加密或无法按声明格式解析"
        )
        status = "FAILED"
    return bundle.finish(status)


def _child(sender, data, document_id, format):
    try:
        sender.send(parse_bytes(data, document_id, format))
    finally:
        sender.close()


class ParseRunner:
    def __init__(self):
        self.slots = asyncio.Semaphore(2)

    async def run(self, data: bytes, document_id: str, format: str) -> dict:
        async with self.slots:
            ctx = multiprocessing.get_context("spawn")
            receiver, sender = ctx.Pipe(duplex=False)
            process = ctx.Process(
                target=_child, args=(sender, data, document_id, format), daemon=True
            )
            try:
                process.start()
                sender.close()
                while not receiver.poll():
                    if not process.is_alive():
                        raise ServiceError("INTERNAL", "文档解析进程异常退出", 500)
                    await asyncio.sleep(0.02)
                try:
                    return await asyncio.to_thread(receiver.recv)
                except (EOFError, OSError) as error:
                    raise ServiceError(
                        "INTERNAL", "文档解析进程未返回完整结果", 500
                    ) from error
            finally:
                sender.close()
                if process.pid is not None:
                    if process.is_alive():
                        process.terminate()
                    await asyncio.to_thread(process.join, 1)
                    if process.is_alive():
                        process.kill()
                        await asyncio.to_thread(process.join, 1)
                    process.close()
                receiver.close()

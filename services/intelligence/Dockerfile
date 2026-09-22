FROM python:3.13-slim
WORKDIR /service
COPY pyproject.toml requirements-dev.lock ./
COPY src ./src
RUN python -m pip install --no-cache-dir --constraint requirements-dev.lock .
USER 65532:65532
EXPOSE 7500
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
  CMD python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:7500/health',timeout=3).status==200 else 1)"
CMD ["python", "-m", "uvicorn", "aiqa_intelligence.app:app", "--host", "0.0.0.0", "--port", "7500"]

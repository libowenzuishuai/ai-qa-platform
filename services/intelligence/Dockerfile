FROM python:3.13-slim
WORKDIR /service
COPY pyproject.toml requirements-dev.lock ./
COPY src ./src
RUN python -m pip install --no-cache-dir --constraint requirements-dev.lock .
USER 65532:65532
EXPOSE 7500
CMD ["python", "-m", "uvicorn", "aiqa_intelligence.app:app", "--host", "0.0.0.0", "--port", "7500"]

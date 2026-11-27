FROM python:3.12-slim
RUN pip install --no-cache-dir "curl_cffi>=0.7,<1"
WORKDIR /app
COPY proxy.py .
EXPOSE 8080
CMD ["python", "proxy.py"]

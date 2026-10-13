#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "=== Kove Advanced GPU Transcription Setup ==="

if ! command -v nvidia-smi &> /dev/null; then
    echo "ERROR: NVIDIA drivers not found. Use a Deep Learning AMI."
    exit 1
fi

echo "GPU detected:"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER
    echo "Docker installed. You may need to log out and back in for group changes."
fi

if ! dpkg -l | grep -q nvidia-container-toolkit; then
    echo "Installing NVIDIA Container Toolkit..."
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
        sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
        sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
        sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
    sudo apt-get update
    sudo apt-get install -y nvidia-container-toolkit
    sudo nvidia-ctk runtime configure --runtime=docker
    sudo systemctl restart docker
fi

# The API requires a bearer token. Generate one on first run rather than letting
# an open GPU endpoint come up on a public IP — this host bills by the second and
# anything that reaches port 8000 would have been able to spend it.
if [ -z "${KOVE_TRANSCRIBE_TOKEN:-}" ] && ! grep -qs '^KOVE_TRANSCRIBE_TOKEN=' .env; then
    TOKEN="$(openssl rand -hex 32)"
    printf 'KOVE_TRANSCRIBE_TOKEN=%s\n' "$TOKEN" > .env
    chmod 600 .env
    echo ""
    echo "Generated an API token and wrote it to $(pwd)/.env (gitignored)."
    echo "Give the same value to the client, which sends it as:"
    echo ""
    echo "    Authorization: Bearer $TOKEN"
    echo ""
fi

echo "Building and starting transcription service..."
docker compose up -d --build

echo ""
echo "Waiting for service to start (model download may take a few minutes)..."
for i in $(seq 1 60); do
    if curl -s http://localhost:8000/health | grep -q '"ready":true'; then
        echo ""
        echo "=== Service is ready! ==="
        curl -s http://localhost:8000/health | python3 -m json.tool
        exit 0
    fi
    printf "."
    sleep 10
done

echo ""
echo "Service not ready yet. Check logs with: docker compose logs -f"

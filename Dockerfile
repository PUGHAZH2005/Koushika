# Dockerfile

# Stage 1: Build stage - Install system dependencies and Python packages
FROM python:3.11-slim-bookworm AS builder

# Set environment variables
ENV DEBIAN_FRONTEND=noninteractive
# --- FIX: Prevent Matplotlib from creating a persistent font cache ---
ENV MPLCONFIGDIR=/tmp/matplotlib

# Install build tools and essential system libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gdal-bin \
    libgdal-dev \
    && rm -rf /var/lib/apt/lists/*

# Set a working directory
WORKDIR /app

# Create a virtual environment
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy your requirements file and install Python packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt


# Stage 2: Final stage - Create the lightweight production image
FROM python:3.11-slim-bookworm

# Set the same environment variables for the final image
ENV DEBIAN_FRONTEND=noninteractive
ENV MPLCONFIGDIR=/tmp/matplotlib

# Install only the RUNTIME system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gdal-bin \
    libgdal32 \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Copy the virtual environment from the builder stage
COPY --from=builder /opt/venv /opt/venv

# Activate the virtual environment
ENV PATH="/opt/venv/bin:$PATH"

# Copy your application code and data
COPY . .

# Expose the port Gunicorn will run on
EXPOSE 10000

# Set the command to run your application using Gunicorn
CMD ["gunicorn", "--config", "gunicorn_config.py", "app:app"]

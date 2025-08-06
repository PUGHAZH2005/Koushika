# Dockerfile

# Stage 1: Build stage - Install system dependencies and Python packages
# Use a specific, stable Debian-based Python image
FROM python:3.11-slim-bookworm AS builder

# Set an environment variable to prevent prompts during apt-get install
ENV DEBIAN_FRONTEND=noninteractive

# Install the essential system libraries for your geospatial packages
# NOTE: PDAL is removed as it is not available in the default Debian repo
RUN apt-get update && apt-get install -y --no-install-recommends \
    gdal-bin \
    libgdal-dev \
    && rm -rf /var/lib/apt/lists/*

# Set a working directory
WORKDIR /app

# Create a virtual environment
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy your requirements file and install Python packages into the venv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt


# Stage 2: Final stage - Create the lightweight production image
# Use the same base image for a smaller final size
FROM python:3.11-slim-bookworm

# Set the same environment variable
ENV DEBIAN_FRONTEND=noninteractive

# Install only the RUNTIME system dependencies (not the -dev ones)
# --- FIX: Corrected libgdal34 to libgdal32 ---
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

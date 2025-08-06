#!/usr/bin/env bash
# exit on error
set -o errexit

# Install required system dependencies for PDAL
apt-get update
apt-get install -y --no-install-recommends pdal libpdal-dev gdal-bin libgdal-dev

# Run the original build command (pip install)
pip install -r requirements.txt
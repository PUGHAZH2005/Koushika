# gunicorn_config.py

# Number of worker processes
workers = 1

# The socket to bind to
bind = '0.0.0.0:10000'

# Timeout for waiting for workers to boot (in seconds).
# Also the timeout for handling individual requests.
# We increase this from the default (30s) to give Matplotlib
# time to build its font cache on the first run.
timeout = 120

# gunicorn_config.py

# Number of worker processes
workers = 1 

# The socket to bind to
bind = '0.0.0.0:10000'

# The timeout for workers after they have booted
timeout = 120

# --- FIX: Add a longer boot timeout ---
# Graceful timeout for worker reboot
graceful_timeout = 120 

# Timeout for waiting for workers to boot (in seconds)
# This is the key change to prevent workers from being killed during slow startup.
# Matplotlib font cache building can be slow.
timeout = 120

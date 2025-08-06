# gunicorn_config.py

# Number of worker processes
workers = 4 

# The socket to bind to
bind = '0.0.0.0:10000'

# The timeout for workers
timeout = 120
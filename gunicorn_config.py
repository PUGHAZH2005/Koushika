# gunicorn_config.py

# --- FIX: Define all settings here for reliability ---

# Set the worker class to the efficient gevent worker
worker_class = 'gevent'

# Set the number of worker processes
workers = 1 

# The socket to bind to. Render provides the PORT environment variable.
# We use a default of 10000 for local testing if the variable isn't set.
port = os.environ.get('PORT', '10000')
bind = f'0.0.0.0:{port}'

# The timeout for workers
timeout = 120

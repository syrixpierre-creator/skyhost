import os
from fastapi import FastAPI
import redis

app = FastAPI()
r = redis.from_url(os.environ['REDIS_URL'])

@app.get('/')
def root():
    return {'hello': os.getenv('GREETING', 'world')}

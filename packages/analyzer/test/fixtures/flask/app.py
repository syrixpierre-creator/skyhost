import os
from flask import Flask
from pymongo import MongoClient

app = Flask(__name__)
client = MongoClient(os.environ.get('MONGODB_URI'))

@app.route('/')
def hello():
    return 'Hello'

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=int(os.environ.get('PORT', 5000)))

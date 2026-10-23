import os
import dj_database_url
SECRET_KEY = os.environ['DJANGO_SECRET_KEY']
DEBUG = os.getenv('DEBUG', '0') == '1'
DATABASES = {'default': dj_database_url.config(default='postgresql://localhost/mysite')}

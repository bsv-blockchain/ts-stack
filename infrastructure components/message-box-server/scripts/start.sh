#!/bin/bash

if [ $NODE_ENV = 'production' ] || [ $NODE_ENV = 'staging' ]
then
  npm run build
  node src/index.js
  exit
fi

until nc -z -v -w30 messagebox-backend-mysql 3001
do
  echo "Waiting for database connection..."
  sleep 1
done
knex migrate:latest
npm run start
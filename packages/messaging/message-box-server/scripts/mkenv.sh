#!/bin/bash

echo "Creating $1"
echo "apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: $SERVICE
spec:
  template:
    spec:
      timeoutSeconds: 3540
      containers:
      - image: $IMAGE
        ports:
        - name: h2c
          containerPort: 8080
        env:" > $1

echo "Appending environment variables to $1"
perl -E'
  say "        - name: $_
          value: \x27$ENV{$_}\x27" for @ARGV;
' NODE_ENV \
    KNEX_DB_CONNECTION \
    BSV_NETWORK \
    WALLET_STORAGE_URL \
    LOGGING_ENABLED \
    SERVER_PRIVATE_KEY >> $1

echo "Built! Contents of $1:"
cat $1

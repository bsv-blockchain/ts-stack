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
        - name: http1
          containerPort: 8080
        resources:
          limits:
            memory: \"4Gi\"
        env:" > $1

echo "Appending environment variables to $1"
perl -E'
  say "        - name: $_
          value: \x27$ENV{$_}\x27" for @ARGV;
' NODE_ENV \
    PRICE_PER_GB_MO \
    MIN_HOSTING_MINUTES \
    HOSTING_DOMAIN \
    ADMIN_TOKEN \
    SERVER_PRIVATE_KEY \
    GCP_STORAGE_CREDS \
    GCP_PROJECT_ID \
    GCP_BUCKET_NAME \
    WALLET_STORAGE_URL \
    BSV_NETWORK \
    HTTP_PORT >> $1

echo "Built! Contents of $1:"
cat $1

echo "HOSTING_DOMAIN: $HOSTING_DOMAIN" >> $2
echo "ADMIN_TOKEN: $ADMIN_TOKEN" >> $2
echo "Built! Contents of $2:"
cat $2

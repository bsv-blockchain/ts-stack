#!/bin/bash

# Memory limit for the container
MEMORY_LIMIT="4Gi" # Example: 512Mi, 1Gi, etc.

echo "Creating $1"
echo "apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: $SERVICE
  labels:
    cloud.googleapis.com/location: us-west1
spec:
  template:
    spec:
      timeoutSeconds: 3540
      containers:
      - image: $IMAGE
        ports:
        - name: h2c
          containerPort: 8080
        resources:
          limits:
            memory: $MEMORY_LIMIT
        env:" > $1

echo "Appending environment variables to $1"

echo "Appending to $1"
perl -E'
  say "        - name: $_
          value: \x27$ENV{$_}\x27" for @ARGV;
' BSV_NETWORK KNEX_DB_CONNECTION SERVER_PRIVATE_KEY TAAL_API_KEY COMMISSION_FEE COMMISSION_PUBLIC_KEY FEE_MODEL  >> $1

echo "Built! Contents of $1:"
cat $1

# Kubernetes Deployment Guide

This guide provides a short overview of deploying the Wallet Infra on Kubernetes.
The example configurations in `guides/kube_samples/` demonstrate a basic wallet infrastructure deployment consisting of a wallet application backed by a MySQL database. The setup includes a dedicated namespace, configuration management through ConfigMaps, a MySQL database deployment with its service, and the main wallet application deployment with an Ingress for external access. The wallet application is exposed through a service and configured with an Ingress controller for HTTP routing.

## Example Configurations

Example Kubernetes configurations can be found in the `guides/kube_samples/` directory. These provide a basic starting point, but should be adapted for production use with the improvements mentioned above.
## Managing Secrets

The wallet application requires several sensitive configurations that should be properly managed as secrets:

1. Create secrets directly (development only):
   ```bash
   # Create MySQL secrets
   kubectl create secret generic mysql-secrets \
     --namespace wallet-infra \
     --from-literal=MYSQL_ROOT_PASSWORD='your-secure-password'

   # Create wallet secrets
   kubectl create secret generic wallet-secrets \
     --namespace wallet-infra \
     --from-literal=SERVER_PRIVATE_KEY='your-private-key-hex' \
     --from-literal=KNEX_DB_CONNECTION='{"host":"mysql","user":"root","password":"same-as-mysql-root-password","database":"wallet_storage","port":3306}'
   ```

   > **Note**: Replace the placeholder values with your actual secure passwords and keys. Use single quotes to handle special characters in passwords.

For production environments, consider these approaches:
- Use a secrets management service (HashiCorp Vault, AWS Secrets Manager)
- Implement a secrets operator (External Secrets Operator)
- Use sealed secrets for GitOps workflows
- Never store sensitive data in ConfigMaps or version control

## Getting Started

**Note:** These examples are based on an AWS environment and will need to be modified for your specific setup:
- The Ingress configuration uses AWS ALB Ingress Controller annotations
- DNS management assumes AWS Route53 with external-dns operator
- Storage class `gp2` is AWS EBS-specific
- You'll need to replace `store.example.com` with your actual domain
- SSL certificate configuration should be adjusted for your environment or handled with an operator

1. Build and push the wallet-infra image to your container registry. For example:

```bash
docker build -t your-registry/wallet-infra:latest .
# Push to your registry
docker push your-registry/wallet-infra:latest
# Update the image path in `wallet.yaml` to point to your registry
```

2. Create namespace:
   ```bash
   kubectl create namespace wallet-infra
   ```

3. Apply ConfigMaps and Secrets:
   ```bash
   kubectl apply -f wallet-configmap.yaml -n wallet-infra
   ```

4. Deploy database:
   ```bash
   kubectl apply -f mysql.yaml -n wallet-infra
   ```

5. Deploy application:
   ```bash
   kubectl apply -f wallet.yaml -n wallet-infra
   ```

## Production Improvements

For a production environment, consider these improvements:

### Infrastructure and Operations
- Use GitOps (Flux/Argo CD) for automated deployments
- Implement monitoring with Prometheus and Grafana
- Set up proper logging with ELK/EFK stack
- Use managed database service (e.g., AWS RDS) instead of self-hosted MySQL

### Scalability and Reliability
- Configure horizontal pod autoscaling
- Deploy across multiple availability zones
- Implement proper backup strategies
- Set appropriate resource quotas and limits

# Docker Deployment Guide

This guide covers deploying the ChaintracksService with Bulk Headers CDN using Docker.

## Quick Start

```bash
# 1. Clone the repository
git clone <repository-url>
cd chaintracks-server

# 2. Create environment file
cp .env.docker .env

# 3. (Optional) Edit .env with your configuration
nano .env

# 4. Start the service
docker compose up -d

# 5. Check logs
docker compose logs -f
```

That's it! The service is now running with:
- ChaintracksService on http://localhost:3011
- Bulk Headers CDN on http://localhost:3012

## Architecture

The Docker setup creates:

1. **ChaintracksService Container** (Port 3011)
   - Tracks blockchain headers
   - Provides header query API
   - Automatically syncs with BSV blockchain

2. **CDN Server** (Port 3012)
   - Serves bulk header files
   - Hosts `mainNetBlockHeaders.json` metadata
   - Exports headers automatically at 100k boundaries

3. **Persistent Volume**
   - Stores bulk header files
   - Survives container restarts
   - Located at `/app/public/headers` in container

## Configuration

### Environment Variables

Edit `.env` file to customize:

```bash
# Chain selection
CHAIN=main  # or 'test' for testnet

# WhatsOnChain API Key (recommended for better rate limits)
WHATSONCHAIN_API_KEY=your_api_key_here

# Source CDN (where to download FROM if local files don't exist)
SOURCE_CDN_URL=https://cdn.projectbabbage.com/blockheaders/

# Enable bulk headers CDN hosting
ENABLE_BULK_HEADERS_CDN=true

# Public URL where YOUR CDN is accessible
# Change this to your domain in production!
CDN_HOST_URL=https://headers.yourdomain.com

# Auto-export interval (67 hours = 400 blocks)
BULK_HEADERS_AUTO_EXPORT_INTERVAL=240000000
```

### Production Configuration

For production deployment:

1. **Set CDN_HOST_URL to your domain:**
   ```bash
   CDN_HOST_URL=https://headers.yourdomain.com
   ```

2. **Configure reverse proxy (nginx example):**
   ```nginx
   # Proxy to CDN server
   server {
       listen 443 ssl;
       server_name headers.yourdomain.com;

       location / {
           proxy_pass http://localhost:3012;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
       }
   }

   # Proxy to ChaintracksService API
   server {
       listen 443 ssl;
       server_name api.yourdomain.com;

       location / {
           proxy_pass http://localhost:3011;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
       }
   }
   ```

3. **Add WhatsOnChain API key** for better rate limits

## Docker Commands

### Start the service
```bash
docker compose up -d
```

### View logs
```bash
# All logs
docker compose logs -f

# Just the service logs
docker compose logs -f chaintracks-server
```

### Stop the service
```bash
docker compose down
```

### Restart the service
```bash
docker compose restart
```

### Rebuild after code changes
```bash
docker compose up -d --build
```

### View resource usage
```bash
docker stats chaintracks-server
```

## Volumes

### Viewing bulk headers
```bash
# List files
docker compose exec chaintracks-server ls -lh /app/public/headers

# View metadata file
docker compose exec chaintracks-server cat /app/public/headers/mainNetBlockHeaders.json
```

### Backup bulk headers
```bash
# Create backup
docker run --rm -v chaintracks-server_bulk-headers:/data -v $(pwd):/backup alpine tar czf /backup/headers-backup.tar.gz -C /data .

# Restore backup
docker run --rm -v chaintracks-server_bulk-headers:/data -v $(pwd):/backup alpine sh -c "cd /data && tar xzf /backup/headers-backup.tar.gz"
```

### Clean up volumes
```bash
# Stop and remove containers and volumes
docker compose down -v
```

## Accessing the Services

### ChaintracksService API (Port 3011)
```bash
# Get chain info
curl http://localhost:3011/getInfo

# Get current height
curl http://localhost:3011/currentHeight

# Get chain tip
curl http://localhost:3011/findChainTipHeader
```

### Bulk Headers CDN (Port 3012)
```bash
# Get metadata
curl http://localhost:3012/mainNetBlockHeaders.json

# Download first 100k headers
curl http://localhost:3012/mainNet_0.headers -o mainNet_0.headers

# Check file size
ls -lh mainNet_0.headers
```

## Troubleshooting

### Container won't start
```bash
# Check logs for errors
docker compose logs chaintracks-server

# Check if ports are already in use
lsof -i :3011
lsof -i :3012
```

### Out of disk space
```bash
# Check volume size
docker system df -v

# Clean up unused Docker resources
docker system prune -a
```

### Headers not exporting
```bash
# Check logs for export messages
docker compose logs chaintracks-server | grep -i export

# Verify CDN is enabled
docker compose exec chaintracks-server printenv | grep CDN

# Manually trigger export by restarting
docker compose restart chaintracks-server
```

### Slow sync
- Add `WHATSONCHAIN_API_KEY` for better rate limits
- Increase `SOURCE_CDN_URL` if you have a closer CDN
- Check resource limits in `docker-compose.yml`

## Resource Requirements

**Minimum:**
- CPU: 1 core
- RAM: 2 GB
- Disk: 5 GB (for headers)

**Recommended:**
- CPU: 2 cores
- RAM: 4 GB
- Disk: 10 GB (with room to grow)

## Monitoring

### Health Check
Docker Compose includes a health check that verifies the service is responding:

```bash
# Check service health
docker compose ps
```

### Logs
```bash
# Follow logs
docker compose logs -f

# Search logs for specific text
docker compose logs | grep "header"

# Last 100 lines
docker compose logs --tail=100
```

## Updating

```bash
# Pull latest code
git pull

# Rebuild and restart
docker compose up -d --build

# Verify update
docker compose logs -f
```

## Network Setup for Other Servers

To have other servers use YOUR server as a CDN source:

**On other servers, set:**
```bash
SOURCE_CDN_URL=http://yourserver:3012
# or
SOURCE_CDN_URL=https://headers.yourdomain.com
```

This creates a self-hosting CDN network where servers download from each other!

## Advanced: Custom Network

To run on a custom Docker network:

```yaml
# docker-compose.yml
services:
  chaintracks-server:
    networks:
      - bsv-network

networks:
  bsv-network:
    driver: bridge
```

## Security Considerations

1. **Don't expose ports directly to internet** - Use reverse proxy
2. **Use HTTPS** in production with SSL certificates
3. **Set resource limits** to prevent resource exhaustion
4. **Regular backups** of the bulk headers volume
5. **Monitor logs** for suspicious activity

## Support

For issues:
1. Check logs: `docker compose logs -f`
2. Check GitHub issues
3. Verify configuration in `.env`
4. Ensure ports 3011 and 3012 are not in use

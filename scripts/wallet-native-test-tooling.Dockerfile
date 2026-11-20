FROM node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
# Exact compiler/development packages from the independently qualified worker.
# A changed/absent package or executable mismatch fails instead of enrolling a build.
RUN apt-get update --error-on=any \
 && apt-get install -y --no-install-recommends \
    gcc=4:12.2.0-3 gcc-12=12.2.0-14+deb12u1 \
    cpp-12=12.2.0-14+deb12u1 libgcc-12-dev=12.2.0-14+deb12u1 \
    libc6-dev=2.36-9+deb12u14 \
 && test "$(cc -dumpfullversion)" = 12.2.0 \
 && dpkg-query -W gcc gcc-12 cpp-12 libgcc-12-dev libc6-dev > /usr/local/share/wallet-native-test-toolchain.txt \
 && rm -rf /var/lib/apt/lists/*
# Qualified execution supplies the actual caller UID/GID explicitly.
USER node

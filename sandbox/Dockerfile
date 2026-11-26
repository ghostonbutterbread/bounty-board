# Bounty Board sandbox terminal image.
# Build on the host that runs terminal_service.py, matching the host user so
# files created in /report keep the host owner:
#   docker build -t bbterm-sandbox:latest --build-arg UID=$(id -u) --build-arg GID=$(id -g) sandbox/
FROM debian:stable-slim

ARG UID=1000
ARG GID=1000

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget jq openssl git python3 python3-requests httpie \
      nodejs npm ncat socat tmux less nano vim-tiny procps iproute2 dnsutils file unzip xxd \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd -g "${GID}" sandbox \
 && useradd -m -u "${UID}" -g "${GID}" -d /home/sandbox -s /bin/bash sandbox \
 && mkdir -p /report /run/bbterm

COPY bbterm-forward.py /usr/local/bin/bbterm-forward
COPY bbterm-ports.py /usr/local/bin/bbterm-ports
COPY bashrc /etc/bbterm.bashrc
RUN chmod 0755 /usr/local/bin/bbterm-forward /usr/local/bin/bbterm-ports \
 && echo '[ -f /etc/bbterm.bashrc ] && . /etc/bbterm.bashrc' >> /etc/bash.bashrc \
 && echo '[ -f /etc/bbterm.bashrc ] && . /etc/bbterm.bashrc' >> /etc/profile

USER sandbox
WORKDIR /report
# The service runs the container with --init, --network none, --read-only and
# the proxy socket mounted at /run/bbterm/proxy.sock. The forwarder is PID 1's child.
# The preview-ports agent dials out to /run/bbterm/ports.sock (only present with
# --preview-ports) and is restarted if anything in the sandbox kills it.
CMD ["sh", "-c", "while :; do python3 /usr/local/bin/bbterm-ports /run/bbterm/ports.sock 3128; sleep 1; done & exec python3 /usr/local/bin/bbterm-forward 3128 /run/bbterm/proxy.sock"]

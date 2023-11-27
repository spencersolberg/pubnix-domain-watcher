# https://gist.github.com/buffrr/609285c952e9cb28f76da168ef8c2ca6

openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
  -keyout /etc/ssl/private/$DOMAIN.key -out /etc/ssl/certs/$DOMAIN.crt -extensions ext  -config \
  <(echo "[req]";
    echo distinguished_name=req;
    echo "[ext]";
    echo "keyUsage=critical,digitalSignature,keyEncipherment";
    echo "extendedKeyUsage=serverAuth";
    echo "basicConstraints=critical,CA:FALSE";
    echo "subjectAltName=DNS:$DOMAIN,DNS:*.$DOMAIN";
    ) -subj "/CN=*.$DOMAIN"
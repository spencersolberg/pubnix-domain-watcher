# https://gist.github.com/buffrr/609285c952e9cb28f76da168ef8c2ca6

# apt install xxd

echo -n "3 1 1 " && openssl x509 -in /etc/ssl/certs/$DOMAIN.crt -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | xxd  -p -u -c 32
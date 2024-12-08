FROM node:23

ENV COUCHDB_URL="couchdb"
ENV COUCHDB_PORT=5984
ENV COUCHDB_USER="couchusername"
ENV COUCHDB_PASS="couchpassword"
ENV COUCHDB_SECRET="couchsecret"
ENV SESSION_SECRET="somesecret"
ENV PRIVATE_KEY="{ \"keydata\": \"somedata\" }"
ENV SENDGRID_API_KEY="SG.somekeyvalue"
ENV MAILERLITE_API_KEY="123123123123123"
ENV SUPPORT_EMAIL="support@somedomain.com"
ENV SUPPORT_URGENT_EMAIL="urgent@somedomain.com"
ENV URGENT_MESSAGE_SUBJECT="Urgent message received"
ENV URGENT_MESSAGE_BODY="Hi,<br><br>This auto-reply is to confirm that we got your urgent message.<br>Your message will appear as a notification and a text message on the developer's phone, which they'll see right away (if they're awake).<br><br>If you have anything else to add that might help us resolve your issue, just reply to this.<br>Is your problem related to one of your documents, or all of them?<br>Does it occur on one of your devices, or all of them?<br>Do you grant us permission to access your account?<br>Anything you can think of, please let us know.<br><br>We're sorry you're having trouble... we'll do our best to help!<br>The Gingko Team"
ENV NTFY_URL="https://ntfy.sh/my_topic"
ENV STRIPE_SECRET_KEY="sk_test_123412341234"
ENV ANTHROPIC_API_KEY="1234123412344"
ENV URL_ROOT="https://localhost:3000"
ENV REDIS_URL="redis://redis"

WORKDIR /www/gingkowriter.com/server

COPY . .

RUN mv config-example.js config.js

RUN npm install
RUN npm run build

EXPOSE 3000

CMD node dist/index.js

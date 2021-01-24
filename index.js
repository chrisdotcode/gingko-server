const express = require('express');
const fs = require('fs')
const path = require('path');
const process = require('process');
const URLSafeBase64 = require('urlsafe-base64');
const uuid = require('uuid');
const crypto = require('crypto');
const axios = require('axios');
const sgMail = require('@sendgrid/mail');
const proxy = require('express-http-proxy');
const config = require("./config.js");
const nano = require('nano')(`http://${config.COUCHDB_USER}:${config.COUCHDB_PASS}@localhost:5984`);
const usersDB = nano.use("_users");
const sessionDB = nano.use("_session");
const promiseRetry = require("promise-retry");
const nodePandoc = require("node-pandoc");


/* ==== SETUP ==== */

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({limit: '50mb'}));

sgMail.setApiKey(config.SENDGRID_API_KEY);


/* ==== Authentication ==== */

app.post('/signup', async (req, res) => {
  let email = req.body.email;
  let userDbName = `userdb-${toHex(email)}`;

  const dbRes = await usersDB.insert(
    { type: "user"
    , roles: []
    , name: email
    , password: req.body.password
    }, `org.couchdb.user:${email}`).catch(async e => e);

  if (dbRes.ok) {
    let loginRes = await axios.post("http://localhost:5984/_session", {
      name: email,
      password: req.body.password
    })

    await promiseRetry((retry, attempt) => {
      return nano.use(userDbName).insert(designDocList).catch(retry);
    }, {minTimeout: 100});

    let data = {email: email, db: userDbName};

    res.status(200).cookie(loginRes.headers['set-cookie']).send(data);
  } else if (dbRes.error == "conflict"){
    res.status(409).send();
  } else {
    res.status(500).send();
  }
});


app.post('/login', async (req, res) => {
  let email = req.body.email;
  let password = req.body.password;
  let userDbName = `userdb-${toHex(email)}`;

  try {
    let loginRes = await axios.post("http://localhost:5984/_session" ,
      { name: email,
        password: password,
      });

    if (loginRes.status == 200) {
      let userDb = nano.use(userDbName);
      let settings = await userDb.get('settings').catch(e => null);
      let docListRes = await userDb.view('testDocList','docList');
      let data = { email: email, settings: settings, documents: docListRes.rows.map(r=> r.value) };

      res.status(200).cookie(loginRes.headers['set-cookie']).send(data);
    }
  } catch (err) {
    res.status(err.response.status).send(err.response.data);
  }
});


app.post('/logout', async (req, res) => {
  try {
    let logoutRes = await axios.delete("http://localhost:5984/_session");
    res.status(200).cookie(logoutRes.headers['set-cookie']).send();
  } catch (err) {
    res.send(err)
  }
});


app.post('/forgot-password', async (req, res) => {
  let email = req.body.email;
  try {
    let user = await usersDB.get(`org.couchdb.user:${email}`);

    let token = newToken();
    user.resetToken = hashToken(token);
    user.resetExpiry = Date.now() + 3600*1000; // one hour expiry

    const dbRes = await usersDB.insert(user);

    if (dbRes.ok) {
      const msg = {
        to: email,
        from: config.SUPPORT_EMAIL,
        subject: 'Password Reset link for Gingkowriter.com',
        text: `The reset link: https://app.gingkowriter.com/reset-password/${token}`,
        html: `The reset link: https://app.gingkowriter.com/reset-password/${token}`
      }

      await sgMail.send(msg);
    }
  } catch (err) {
    console.log(err)
  }
});


app.post('/reset-password', async (req, res) => {
  let token = req.body.token;
  let newPassword = req.body.password;

  try {
    let searchRes = await usersDB.find({"selector": {"resetToken": hashToken(token)}});
    let user = searchRes.docs[0];
    let email = user.name;
    let userDbName = `userdb-${toHex(user.email)}`;

    // change password and save to DB
    user.password = newPassword;
    delete user.resetToken;
    delete user.resetExpiry;
    const dbRes = await usersDB.insert(user);

    if (dbRes.ok) {
      let loginRes = await axios.post("http://localhost:5984/_session", {
        name: email,
        password: newPassword
      })

      if (loginRes.status == 200) {
        let userDb = nano.use(userDbName);
        let settings = await userDb.get('settings').catch(e => null);
        let data = { email: email, settings: settings };

        res.status(200).cookie(loginRes.headers['set-cookie']).send(data);
      }
    } else {
      res.status(500).send();
    }
  } catch (err) {
    console.log(err)
    res.status(err.response.status).send(err.response.data);
  }
});



/* ==== Payment ==== */

const Stripe = require('stripe');
const stripe = Stripe(config.STRIPE_SECRET_KEY);

app.post('/create-checkout-session', async (req, res) => {
  const { priceId } = req.body;

  // See https://stripe.com/docs/api/checkout/sessions/create
  // for additional parameters to pass.
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          // For metered billing, do not pass quantity
          quantity: 1,
        },
      ],
      // {CHECKOUT_SESSION_ID} is a string literal; do not change it!
      // the actual Session ID is returned in the query parameter when your customer
      // is redirected to the success page.
      success_url: config.URL_ROOT + '/payment/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: config.URL_ROOT,
    });

    res.send({
      sessionId: session.id,
    });
  } catch (e) {
    res.status(400);
    return res.send({
      error: {
        message: e.message,
      }
    });
  }
});


app.post('/hooks', (req, res) => {
  let event = req.body;


  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      console.log(event.data.object);
      break;
    case 'payment_method.attached':
      const paymentMethod = event.data.object;
      // Then define and call a method to handle the successful attachment of a PaymentMethod.
      // handlePaymentMethodAttached(paymentMethod);
      break;
    // ... handle other event types
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  // Return a res to acknowledge receipt of the event
  res.json({received: true});
});




/* ==== Export ==== */

app.post('/export-docx', async (req, res) => {
  // receive Markdown string, return file download of docx
  let srcFile = `./${req.body.docId}.tmp.md`;
  let outFile = `${req.body.docId}.docx`
  res.header('Content-Type', 'application/octet-stream; charset=utf-8');

  fs.writeFile(srcFile, req.body.markdown, () => {
    let args =['-f', 'markdown', '-t', 'docx', '-o', outFile]
    nodePandoc(srcFile, args, () => {
      fs.createReadStream(outFile).pipe(res);
    })
  });
});




/* ==== Static ==== */

app.use(express.static("../client/web"));




/* ==== Dev db proxy ==== */

// Can only reach this route in dev machine.
// On production server, nginx does the proxying.
app.use('/db', proxy("localhost:5984", {
  async userResHeaderDecorator(headers) {
    return headers;
  }
}));




/* ==== Single Page App ==== */

// Respond to all non-file requests with index.html
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../client/web/index.html'));
});



/* ==== Start Server ==== */

app.listen(port, () => console.log(`Example app listening at https://localhost:${port}`));




/* === HELPERS === */


designDocList =
  {
    "_id": "_design/testDocList",
    "views": {
      "docList": {
        "map": "function (doc) {\n  if (/metadata/.test(doc._id)) {\n    emit(doc._id, doc);\n  }\n}"
      }
    },
    "language": "javascript"
  };


function toHex(s) {
    // utf8 to latin1
    var s = unescape(encodeURIComponent(s));
    var h = "";
    for (var i = 0; i < s.length; i++) {
        h += s.charCodeAt(i).toString(16);
    }
    return h;
}


function newToken() {
 return URLSafeBase64.encode(uuid.v4(null, new Buffer(16)));
}


function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

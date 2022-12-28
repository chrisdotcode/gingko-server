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
const session = require('express-session');
const config = require("./config.js");
const nano = require('nano')(`http://${config.COUCHDB_USER}:${config.COUCHDB_PASS}@localhost:5984`);
const usersDB = nano.use("_users");
const promiseRetry = require("promise-retry");
const nodePandoc = require("node-pandoc");

/* ==== SQLite3 ==== */

const Database = require('better-sqlite3');
const db = new Database('data.db');
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, salt TEXT, password TEXT, createdAt INTEGER)');
const userByEmail = db.prepare('SELECT * FROM users WHERE id = ?');


/* ==== SETUP ==== */

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({ extended: true }));

sgMail.setApiKey(config.SENDGRID_API_KEY);

// Session

const createClient = require("redis").createClient;
const RedisStore = require('connect-redis')(session);
const redis = createClient({legacyMode: true});
redis.connect().catch(console.error);

redis.on("error", function (err) {
  console.log("Redis Error " + err);
});
redis.on("connect", function () {
  console.log("Redis connected");
});
app.use(session({
    store: new RedisStore({ client: redis }),
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: /* 14 days */ 1209600000 }
}));


/* ==== Authentication ==== */

const iterations = 10;
const keylen = 20;
const size = 16;
const encoding = 'hex';
const digest = 'SHA1';

function isAuthenticated (req, res, next) {
  if (req.session.user) next()
  else next('route')
}

app.post('/signup', async (req, res) => {
  let email = req.body.email.toLowerCase();
  let didSubscribe = req.body.subscribed;
  let userDbName = `userdb-${toHex(email)}`;
  let timestamp = Date.now();
  let confirmTime = didSubscribe ? null : timestamp;

  const dbRes = await usersDB.insert(
    { type: "user"
    , roles: []
    , name: email
    , password: req.body.password
    , created_at: timestamp
    }, `org.couchdb.user:${email}`).catch(async e => e);

  if (dbRes.ok) {
    if (email !== "cypress@testing.com" && didSubscribe) {
      try {
        const options =
          {  url: "https://api.mailerlite.com/api/v2/groups/106198315/subscribers"
          ,  method: 'post'
          ,  headers: { 'Accept': 'application/json'
                      , 'X-MailerLite-ApiDocs': 'true'
                      , 'Content-Type': 'application/json'
                      , 'X-MailerLite-ApiKey': config.MAILERLITE_API_KEY
                      }
          , data: { email: email
                  , resubscribe: true
                  , autoresponders: true
                  , type: 'unconfirmed'
                  }
          };
        axios(options);
      } catch (mailErr) {
        console.log(mailErr);
      }
    }

    let loginRes = await axios.post("http://localhost:5984/_session", {
      name: email,
      password: req.body.password
    })

    await promiseRetry((retry, attempt) => {
      return nano.use(userDbName).insert(designDocList).catch(retry);
    }, {minTimeout: 100});

    let settings = defaultSettings(email, "en", timestamp, 14, confirmTime);
    let settingsRes = await nano.use(userDbName).insert(settings);
    settings["rev"] = settingsRes.rev;

    let data = {email: email, db: userDbName, settings: settings};

    res.status(200).cookie(loginRes.headers['set-cookie']).send(data);
  } else if (dbRes.error == "conflict"){
    res.status(409).send();
  } else {
    res.status(500).send();
  }
});


app.post('/login', async (req, res) => {
  let email = req.body.email.toLowerCase();
  let password = req.body.password;
  session.username = email;
  session.password = password;
  let userDbName = `userdb-${toHex(email)}`;

  // Check SQLite DB for user and password
  let user = userByEmail.get(email);
  if (user !== undefined) {
    console.log("SQLite3 user found", user);
    crypto.pbkdf2(password, user.salt, iterations, keylen, digest, (err, derivedKey) => {
        if (err) throw err;
        if (derivedKey.toString(encoding) === user.password) {
          console.log("SQLite3 login");
          req.session.regenerate(function(err) {
            if(err) { console.log(err); }

            req.session.user = email;

            req.session.save((err) => {
                if(err) { console.log(err); }

                console.log('new session created', req.session);
                res.status(200).send({email: email, db: userDbName});
            })
          });
        } else {
          console.log("SQLite3 password incorrect", err);
        }
    });
  }

  /*
  try {
    let loginRes = await axios.post("http://localhost:5984/_session" ,
      { name: email,
        password: password,
      });

    if (loginRes.status == 200) {
      let userDb = nano.use(userDbName);
      let settings = await userDb.get('settings').catch(e => null);
      let docListRes = await userDb.view('testDocList','docList').catch(r => {return {rows: []};});
      let data = { email: email, settings: settings, documents: docListRes.rows.map(r=> r.value) };

      res.status(200).cookie(loginRes.headers['set-cookie']).send(data);
    }
  } catch (err) {
    res.status(err.response.status).send(err.response.data);
  }

   */
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
      res.status(200).send({email: email})
    }
  } catch (err) {
    res.status(err.statusCode).send();
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



/* ==== DB proxy ==== */

app.use('/db', proxy('http://localhost:5984', {
  proxyReqOptDecorator: function(proxyReqOpts, srcReq) {
    if (srcReq.session.user) {
      proxyReqOpts.headers['X-Auth-CouchDB-UserName'] = srcReq.session.user;
      proxyReqOpts.headers['X-Auth-CouchDB-Roles'] = '';
    }
    return proxyReqOpts;
  }
}));


/* ==== Contact Us Route ==== */

app.post('/pleasenospam', async (req, res) => {
  const msg = {
    to: req.body.toEmail,
    from: config.SUPPORT_EMAIL,
    replyTo: req.body.fromEmail,
    cc: req.body.fromEmail,
    subject: req.body.subject,
    text: req.body.body,
    html: req.body.body,
  }

  const urgentAutoresponse = {
    to: req.body.fromEmail,
    from: config.SUPPORT_URGENT_EMAIL,
    subject: config.URGENT_MESSAGE_SUBJECT,
    html: config.URGENT_MESSAGE_BODY,
  }

  try {
    await sgMail.send(msg);

    if (req.body.toEmail == config.SUPPORT_URGENT_EMAIL) {
      await sgMail.send(urgentAutoresponse);
    }

    res.status(201).send();
  } catch (err) {
    console.log(err.response.body.errors)
    res.status(err.response.status).send(err.response.data);
  }
});



/* ==== Payment ==== */

const Stripe = require('stripe');
const stripe = Stripe(config.STRIPE_SECRET_KEY);

app.post('/create-checkout-session', async (req, res) => {
  const { priceId, customer_email } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      allow_promotion_codes: true,
      customer_email: customer_email,
      success_url: config.URL_ROOT + '/upgrade/success?session_id={CHECKOUT_SESSION_ID}',
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


app.post('/create-portal-session', async (req, res) => {
  const { customer_id } = req.body;

  const session = await stripe.billingPortal.sessions.create({
    customer: customer_id
  });

  res.redirect(session.url);
});


app.post('/hooks', async (req, res) => {
  let event = req.body;

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      // Get data from event
      let email = event.data.object.customer_email;
      let custId = event.data.object.customer;

      // Get user's database
      let userDbName = `userdb-${toHex(email)}`;
      let userDb = nano.use(userDbName);

      // Update user's settings
      let settings = {};
      try {
        settings = await userDb.get('settings');
      } catch (err) {
        if (err.error === "not_found") {
          settings = defaultSettings(email, "en", Date.now(), 14);
        }
        console.log(err)
      }
      settings.paymentStatus = { customer: custId };
      let dbSaveRes = await userDb.insert(settings);
      break;
    // ... handle other event types
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  // Return a res to acknowledge receipt of the event
  res.json({received: true});
});


/* ==== Mail confirmation ==== */

let confirmedHandler = async (email, date) => {
  // Posix time
  let timestamp = Date.parse(date);

  // get user settings object
  let userDbName = `userdb-${toHex(email)}`;
  let userDb = nano.use(userDbName);
  let settings = await userDb.get('settings').catch(e => null);

  if (settings !== null) {
    settings.confirmedAt = timestamp;

    return userDb.insert(settings);
  }
};

app.post('/mlhooks', async (req, res) => {
  let events = req.body.events;


  // Handle the events
  let subscribers = events.map(x => x.data.subscriber);

  let confirmPromises = subscribers.filter(s => s.confirmation_timestamp).map(s => {
    if (s.confirmation_timestamp) {
      confirmedHandler(s.email, s.confirmation_timestamp);
    }
  });

  await Promise.all(confirmPromises);

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


function defaultSettings(email, language = "en", trialStart, trialLength, confirmedTime) {
  let trialExpires = trialStart + trialLength*24*3600*1000;
  return {_id: "settings", email, language, paymentStatus: {trialExpires}, confirmedAt: (confirmedTime || null)};
}


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

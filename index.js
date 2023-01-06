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
const cookieParser = require('cookie-parser');
const config = require("./config.js");
const nano = require('nano')(`http://${config.COUCHDB_USER}:${config.COUCHDB_PASS}@localhost:5984`);
const promiseRetry = require("promise-retry");
const nodePandoc = require("node-pandoc");
const ws = require('ws');

/* ==== SQLite3 ==== */

const Database = require('better-sqlite3');
const db = new Database('data.sqlite');
db.pragma('journal_mode = WAL');

// Users Table
db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, salt TEXT, password TEXT, createdAt INTEGER)');
const userByEmail = db.prepare('SELECT * FROM users WHERE id = ?');
const userSignup = db.prepare('INSERT INTO users (id, salt, password, createdAt) VALUES (?, ?, ?, ?)');
const userChangePassword = db.prepare('UPDATE users SET salt = ?, password = ? WHERE id = ?');
const deleteTestUser = db.prepare("DELETE FROM users WHERE id = 'cypress@testing.com'");
const deleteTestUserTrees = db.prepare("DELETE FROM trees WHERE owner = 'cypress@testing.com'");

// Reset Token Table
db.exec('CREATE TABLE IF NOT EXISTS resetTokens (token TEXT PRIMARY KEY, email TEXT, createdAt INTEGER)');
const resetToken = db.prepare('SELECT * FROM resetTokens WHERE token = ?');
const resetTokenInsert = db.prepare('INSERT INTO resetTokens (token, email, createdAt) VALUES (?, ?, ?)');
const resetTokenDelete = db.prepare('DELETE FROM resetTokens WHERE email = ?');

// Trees Table
db.exec('CREATE TABLE IF NOT EXISTS trees (id TEXT PRIMARY KEY, name TEXT, location TEXT, owner TEXT, collaborators TEXT, inviteUrl TEXT, createdAt INTEGER, updatedAt INTEGER, deletedAt INTEGER)');
const treesByOwner = db.prepare('SELECT * FROM trees WHERE owner = ?');
const treeUpsert = db.prepare('INSERT OR REPLACE INTO trees (id, name, location, owner, collaborators, inviteUrl, createdAt, updatedAt, deletedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const upsertMany = db.transaction((trees) => {
    for (const tree of trees) {
        treeUpsert.run(tree.id, tree.name, tree.location, tree.owner, tree.collaborators, tree.inviteUrl, tree.createdAt, tree.updatedAt, tree.deletedAt);
    }
});

// Cards Table
db.exec('CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, treeId TEXT, content TEXT, parentId TEXT, position FLOAT, updatedAt INTEGER, deleted BOOLEAN)');
const cardsSince = db.prepare('SELECT * FROM cards WHERE treeId = ? AND updatedAt > ? ORDER BY updatedAt ASC');
const cardsAllUndeleted = db.prepare('SELECT * FROM cards WHERE treeId = ? AND deleted = FALSE ORDER BY updatedAt ASC');


/* ==== SETUP ==== */

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({ extended: true }));

sgMail.setApiKey(config.SENDGRID_API_KEY);


/* ==== Start Server ==== */

const server = app.listen(port, () => console.log(`Example app listening at https://localhost:${port}`));

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

/* ==== WebSocket ==== */

const wss = new ws.WebSocketServer({noServer: true});
const wsToUser = new Map();

wss.on('connection', (ws, req) => {
  const userId = req.session.user;
  wsToUser.set(ws, userId);

  ws.send(JSON.stringify({t: "trees", d: treesByOwner.all(userId)}));

  ws.on('message', function incoming(message) {
    const msg = JSON.parse(message);
    try {
      switch (msg.t) {
        case 'pull':
          if (msg.d[1] == '0') {
            const cards = cardsAllUndeleted.all(msg.d[0]);
            console.log('cards', cards, msg);
            ws.send(JSON.stringify({t: 'cards', d: cards}));
          } else {
            const cards = cardsSince.all(msg.d[0], msg.d[1]);
            ws.send(JSON.stringify({t: 'cards', d: cards}));
          }
          break;

        case "trees":
          upsertMany(msg.d);
          ws.send(JSON.stringify({t: "treesOk", d: msg.d.sort((a, b) => a.createdAt - b.createdAt)[0].updatedAt}));
          const usersToNotify = msg.d.map(tree => tree.owner);
          for (const [otherWs, userId] of wsToUser) {
            if (usersToNotify.includes(userId) && otherWs !== ws) {
              otherWs.send(JSON.stringify({t: "trees", d: treesByOwner.all(userId)}));
            }
          }
          break;
      }
    } catch (e) {
      console.error(e);
    }
  });

  ws.on('close', () => {
    wsToUser.delete(ws);
  });
});

server.on('upgrade', async (request, socket, head) => {
  const sessionCookie = request.headers.cookie.split(';').find(row => row.trim().startsWith('connect.sid='));
  const sessionId = sessionCookie.split('=')[1];
  const signedCookie = cookieParser.signedCookie(decodeURIComponent(sessionId), config.SESSION_SECRET);
  if (signedCookie === false) {
    socket.destroy();
  } else {
    const session = await new Promise((resolve, reject) => {
      redis.get(`sess:${signedCookie}`, (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(JSON.parse(data));
        }
      });
    });
    if (session.user) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        request.session = session;
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  }
});



/* ==== Authentication ==== */

const iterations = 10;
const keylen = 20;
const encoding = 'hex';
const digest = 'SHA1';

app.post('/signup', async (req, res) => {
  const email = req.body.email.toLowerCase();
  const password = req.body.password;
  let didSubscribe = req.body.subscribed;
  let userDbName = `userdb-${toHex(email)}`;
  let timestamp = Date.now();
  let confirmTime = didSubscribe ? null : timestamp;

  const salt = crypto.randomBytes(16).toString('hex');
  let hash = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest).toString(encoding);
  try {
    userSignup.run(email, salt, hash, timestamp);

    if (email !== "cypress@testing.com" && didSubscribe) {
      try {
        const options =
            {
              url: "https://api.mailerlite.com/api/v2/groups/106198315/subscribers"
              , method: 'post'
              , headers: {
                'Accept': 'application/json'
                , 'X-MailerLite-ApiDocs': 'true'
                , 'Content-Type': 'application/json'
                , 'X-MailerLite-ApiKey': config.MAILERLITE_API_KEY
              }
              , data: {
                email: email
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

    req.session.regenerate((err) => {
      if(err) { console.log(err); }

      req.session.user = email;

      req.session.save(async (err) => {
        if(err) { console.log(err); }

        await nano.db.create(userDbName);
        const userDb = nano.use(userDbName);

        await promiseRetry((retry, attempt) => {
          return userDb.insert(designDocList).catch(retry);
        }, {minTimeout: 100});

        let settings = defaultSettings(email, "en", timestamp, 14, confirmTime);
        let settingsRes = await userDb.insert(settings);
        settings["rev"] = settingsRes.rev;

        await nano.request({db: userDbName, method: 'put', path: '/_security', body: {members: {names: [email], roles: []}}});

        let data = {email: email, db: userDbName, settings: settings};

        res.status(200).send(data);
      })
    })
  } catch (e) {
    if (e.code && e.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      res.status(409).send();
    } else {
      console.log(e);
      res.status(500).send({error: "Internal server error"});
    }
  }
});


app.post('/login', async (req, res) => {
  let email = req.body.email.toLowerCase();
  let password = req.body.password;
  let userDbName = `userdb-${toHex(email)}`;

  // Check SQLite DB for user and password
  let user = userByEmail.get(email);
  if (user !== undefined) {
    crypto.pbkdf2(password, user.salt, iterations, keylen, digest, (err, derivedKey) => {
        if (err) throw err;
        if (derivedKey.toString(encoding) === user.password) {
          // Authentication successful
          doLogin(req, res, email, userDbName);
        } else {
          res.status(401).send();
        }
    });
  }
});

function doLogin(req, res, email, userDbName) {
  req.session.regenerate(function(err) {
    if(err) { console.log(err); }

    req.session.user = email;

    req.session.save(async (err) => {
      if(err) { console.log(err); }

      let userDb = nano.use(userDbName);
      let settings = await userDb.get('settings').catch(e => {console.error(e); return null});
      let docListRes = await userDb.view('testDocList','docList').catch(r => {return {rows: []};});
      let data = { email: email, settings: settings, documents: docListRes.rows.map(r=> r.value) };

      res.status(200).send(data);
    })
  });
}


app.post('/logout', async (req, res) => {
  if (req.session.user) {
    req.session.destroy((err) => {
      if(err) { console.log(err); }
      res.clearCookie("connect.sid").status(200).send();
    });
  } else {
    res.status(200).send();
  }
});


app.post('/forgot-password', async (req, res) => {
  let email = req.body.email;
  try {
    let user = userByEmail.run(email);

    let token = newToken();
    user.resetToken = hashToken(token); // Consider not hashing token for test user, so we can check it
    user.tokenCreatedAt = Date.now();

    resetTokenInsert.run(user.resetToken, email, user.tokenCreatedAt);

    const msg = {
      to: email,
      from: config.SUPPORT_EMAIL,
      subject: 'Password Reset link for Gingkowriter.com',
      text: `The reset link: https://app.gingkowriter.com/reset-password/${token}`,
      html: `The reset link: https://app.gingkowriter.com/reset-password/${token}`
    }

    await sgMail.send(msg);
    res.status(200).send({email: email})
  } catch (err) {
    res.status(err.statusCode).send();
  }
});


app.post('/reset-password', async (req, res) => {
  let token = req.body.token;
  let newPassword = req.body.password;

  try {
    let tokenRow = resetToken.get(hashToken(token));
    let timeElapsed = Date.now() - tokenRow.createdAt;
    if (timeElapsed < 3600000) {
        let user = userByEmail.get(tokenRow.email);
        if (user) {
            const salt = crypto.randomBytes(16).toString('hex');
            let hash = crypto.pbkdf2Sync(newPassword, salt, iterations, keylen, digest).toString(encoding);
            userChangePassword.run(salt, hash, user.id);
            doLogin(req, res, user.id, `userdb-${toHex(user.id)}`);
        } else {
            res.status(404).send();
        }
    }

    // Whether the token is expired or not, delete it from the database
    resetTokenDelete.run(tokenRow.email);
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



/* ==== Testing ==== */

app.delete('/test/user', async (req, res) => {
  let userDbName = `userdb-${toHex("cypress@testing.com")}`;

  try {
    await nano.db.destroy(userDbName).catch(e => null);
    deleteTestUser.run();
    deleteTestUserTrees.run();
    userByEmail.run("cypress@testing.com");
    res.status(200).send();
  } catch (err) {
    console.log(err);
    res.status(500).send(err);
  }
});

app.post('/test/trees', async (req, res) => {
  trees = req.body;
  try {
    upsertMany(trees);
    res.status(200).send();
  } catch (err) {
    console.log(err);
    res.status(500).send(err);
  }
});




/* ==== Static ==== */

app.use(express.static("../client/web"));






/* ==== Single Page App ==== */

// Respond to all non-file requests with index.html
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../client/web/index.html'));
});




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

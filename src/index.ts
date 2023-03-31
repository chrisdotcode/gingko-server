//@ts-strict-ignore
// Node.js
import fs from "node:fs";
import crypto from "node:crypto";
import { Buffer } from 'node:buffer';

// Databases
import Nano from "nano";
import Database from 'better-sqlite3'
import { createClient } from "redis";

// Networking & Server
import express from "express";
import proxy from "express-http-proxy";
import session from "express-session";
import redisConnect from 'connect-redis';
import cookieParser from "cookie-parser";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import sgMail from "@sendgrid/mail";
import config from "../config.js";
import Stripe from 'stripe';

// Misc
import promiseRetry from "promise-retry";
import _ from "lodash";
import {compact, expand, SnapshotCompaction} from './snapshots.js';
import nodePandoc from "node-pandoc";
import URLSafeBase64 from "urlsafe-base64";
import * as uuid from "uuid";
import hlc from "@tpp/hybrid-logical-clock";




/* ==== SQLite3 ==== */

const db = new Database('../data/data.sqlite');
db.pragma('journal_mode = WAL');

// Litestream Recommendations
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

// Users Table
db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, salt TEXT, password TEXT, createdAt INTEGER, confirmedAt INTEGER, paymentStatus TEXT, language TEXT)');
const userByEmail = db.prepare('SELECT * FROM users WHERE id = ?');
const userByRowId = db.prepare('SELECT * FROM users WHERE rowid = ?');
const userSignup = db.prepare('INSERT INTO users (id, salt, password, createdAt, paymentStatus, language) VALUES (?, ?, ?, ?, ?, ?)');
const userChangePassword = db.prepare('UPDATE users SET salt = ?, password = ? WHERE id = ?');
const userSetLanguage = db.prepare('UPDATE users SET language = ? WHERE id = ?');
const userSetPaymentStatus = db.prepare('UPDATE users SET paymentStatus = ? WHERE id = ?');
const deleteTestUser = db.prepare("DELETE FROM users WHERE id = 'cypress@testing.com'");

// Reset Token Table
db.exec('CREATE TABLE IF NOT EXISTS resetTokens (token TEXT PRIMARY KEY, email TEXT, createdAt INTEGER)');
const resetToken = db.prepare('SELECT * FROM resetTokens WHERE token = ?');
const resetTokenInsert = db.prepare('INSERT INTO resetTokens (token, email, createdAt) VALUES (?, ?, ?)');
const resetTokenDelete = db.prepare('DELETE FROM resetTokens WHERE email = ?');

// Trees Table
db.exec('CREATE TABLE IF NOT EXISTS trees (id TEXT PRIMARY KEY, name TEXT, location TEXT, owner TEXT, collaborators TEXT, inviteUrl TEXT, createdAt INTEGER, updatedAt INTEGER, deletedAt INTEGER)');
const deleteTestUserTrees = db.prepare("DELETE FROM trees WHERE owner = 'cypress@testing.com'");
const treesByOwner = db.prepare('SELECT * FROM trees WHERE owner = ?');
const treeOwner = db.prepare('SELECT owner FROM trees WHERE id = ?').pluck();
const treeUpsert = db.prepare('INSERT OR REPLACE INTO trees (id, name, location, owner, collaborators, inviteUrl, createdAt, updatedAt, deletedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const upsertMany = db.transaction((trees) => {
    for (const tree of trees) {
        treeUpsert.run(tree.id, tree.name, tree.location, tree.owner, tree.collaborators, tree.inviteUrl, tree.createdAt, tree.updatedAt, tree.deletedAt);
    }
});

// Cards Table
db.exec('CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, treeId TEXT, content TEXT, parentId TEXT, position FLOAT, updatedAt TEXT, deleted BOOLEAN)');
const cardsSince = db.prepare('SELECT * FROM cards WHERE treeId = ? AND updatedAt > ? ORDER BY updatedAt ASC');
const cardsAllUndeleted = db.prepare('SELECT * FROM cards WHERE treeId = ? AND deleted = FALSE ORDER BY updatedAt ASC');
const cardById = db.prepare('SELECT * FROM cards WHERE id = ?');
const cardInsert = db.prepare('INSERT OR REPLACE INTO cards (updatedAt, id, treeId, content, parentId, position, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)');
const cardUpdate = db.prepare('UPDATE cards SET updatedAt = ?, content = ? WHERE id = ?');
const cardMove = db.prepare('UPDATE cards SET updatedAt = ?, parentId = ?, position = ? WHERE id = ?');
const cardDelete = db.prepare('UPDATE cards SET updatedAt = ?, deleted = TRUE WHERE id = ?');
const cardUndelete = db.prepare('UPDATE cards SET deleted = FALSE WHERE id = ?');

// Tree Snapshots Table
db.exec('CREATE TABLE IF NOT EXISTS tree_snapshots ( snapshot TEXT, treeId TEXT, id TEXT, content TEXT, parentId TEXT, position REAL, updatedAt TEXT, delta BOOLEAN)')
const takeSnapshotSQL = db.prepare('INSERT INTO tree_snapshots (snapshot, treeId, id, content, parentId, position, updatedAt, delta) SELECT (1000*unixepoch()) || \':\' || treeId, treeId, id, content, parentId, position, updatedAt, 0 FROM cards WHERE treeId = ? AND deleted != 1');
const getSnapshots = db.prepare('SELECT * FROM tree_snapshots WHERE treeId = ? ORDER BY snapshot ASC');
const removeSnapshot = db.prepare('DELETE FROM tree_snapshots WHERE snapshot = ? AND treeId = ?');
const insertSnapshotDeltaRow = db.prepare('INSERT INTO tree_snapshots (snapshot, treeId, id, content, parentId, position, updatedAt, delta) VALUES (@snapshot, @treeId, @id, @content, @parentId, @position, @updatedAt, 1);');
const compactAll = db.transaction((compactions : SnapshotCompaction[]) => {
  for(const compaction of compactions) {
    removeSnapshot.run(compaction.snapshot, compaction.treeId);
    for (const row of compaction.compactedData) {
      insertSnapshotDeltaRow.run(row);
    }
  }
});

_.mixin({
  memoizeDebounce: function(func, wait=0, options={}) {
    var mem = _.memoize(function() {
      return _.debounce(func, wait, options)
    }, options.resolver);
    return function(){mem.apply(this, arguments).apply(this, arguments)}
  }
});
//@ts-ignore
const takeSnapshotDebounced = _.memoizeDebounce((treeId) => {
    takeSnapshotSQL.run(treeId);
} , 5 * 1 * 1000 /* 5 seconds */
  , { maxWait: 25 * 1 * 1000 /* 25 seconds */ }
);


/* ==== SETUP ==== */

const nano = Nano(`http://${config.COUCHDB_USER}:${config.COUCHDB_PASS}@127.0.0.1:5984`);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({ extended: true }));

sgMail.setApiKey(config.SENDGRID_API_KEY);


/* ==== Start Server ==== */

const server = app.listen(port, () => console.log(`Example app listening at https://localhost:${port}`));

// Session

const RedisStore = redisConnect(session);
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

const wss = new WebSocketServer({noServer: true});
const wsToUser = new Map();

wss.on('connection', (ws, req) => {
  const userId = req.session.user;
  wsToUser.set(ws, userId);

  const userDataUnsafe = userByEmail.get(userId);
  if (userDataUnsafe && userDataUnsafe.paymentStatus) {
    const userData = _.omit(userDataUnsafe, ['salt', 'password']);
    ws.send(JSON.stringify({t: "user", d: userData}));
  }

  console.time("trees load");
  ws.send(JSON.stringify({t: "trees", d: treesByOwner.all(userId)}));
  console.timeEnd("trees load");

  ws.on('message', function incoming(message) {
    try {
      const msg = JSON.parse(message);
      switch (msg.t) {
        case "trees":
          console.time("trees");
          // TODO : Should only be able to modify trees that you own
          upsertMany(msg.d);
          ws.send(JSON.stringify({t: "treesOk", d: msg.d.sort((a, b) => a.createdAt - b.createdAt)[0].updatedAt}));
          const usersToNotify = msg.d.map(tree => tree.owner);
          for (const [otherWs, userId] of wsToUser) {
            if (usersToNotify.includes(userId) && otherWs !== ws) {
              console.log('also sending via notification')
              otherWs.send(JSON.stringify({t: "trees", d: treesByOwner.all(userId)}));
            }
          }
          console.timeEnd("trees");
          break;

        case 'pull':
          console.time('pull');
          // TODO : Should only be able to pull trees that you own (or are shared with)
          if (msg.d[1] == '0') {
            const cards = cardsAllUndeleted.all(msg.d[0]);
            ws.send(JSON.stringify({t: 'cards', d: cards}));
          } else {
            const cards = cardsSince.all(msg.d[0], msg.d[1]);
            ws.send(JSON.stringify({t: 'cards', d: cards}));
          }
          console.timeEnd('pull');
          break;

        case 'push':
          // No need for permissions check, as the conflict resolution will take care of it
          console.time('push');
          let conflictExists = false;
          const lastTs = msg.d.dlts[msg.d.dlts.length - 1].ts;
          const treeId = msg.d.tr;

          // Note : If I'm not generating any hybrid logical clock values,
          // then having this here is likely pointless.
          hlc.recv(lastTs);

          const deltasTx = db.transaction(() => {
            for (let delta of msg.d.dlts) {
              runDelta(treeId, delta, userId)
            }
          });
          try {
            deltasTx();
            takeSnapshotDebounced(treeId);
          } catch (e) {
            conflictExists = true; // TODO : Check if this is the right error
            console.log(e.message);
          }

          if (conflictExists) {
            const cards = cardsSince.all(msg.d.tr, msg.d.chk);
            ws.send(JSON.stringify({t: 'cards', d: cards}));
          } else {
            ws.send(JSON.stringify({t: 'pushOk', d: lastTs}));

            const owner = treeOwner.get(treeId);
            const usersToNotify = [owner];
            for (const [otherWs, userId] of wsToUser) {
              if (usersToNotify.includes(userId) && otherWs !== ws) {
                otherWs.send(JSON.stringify({t: "doPull", d: treeId}));
              }
            }
          }
          console.timeEnd('push');
          break;

        case 'pullHistoryMeta': {
          // TODO : Should only be able to pull history meta that you own (or are shared with)
          console.time('pullHistoryMeta');
          const treeId = msg.d;
          const history = getSnapshots.all(treeId);
          const historyMeta = _.chain(history)
            .groupBy('snapshot')
            .mapValues(s => ({id: s[0].snapshot, ts: s[0].snapshot}))
            .values()
            .value();
          ws.send(JSON.stringify({t: 'historyMeta', d: historyMeta, tr: treeId}));
          console.timeEnd('pullHistoryMeta');
          break;
        }

        case 'pullHistory': {
          // TODO : Should only be able to pull history that you own (or are shared with)
          console.time('pullHistory');
          const treeId = msg.d;
          const history = getSnapshots.all(treeId);
          const expandedHistory = expand(history);
          const historyData = _.chain(expandedHistory)
            .groupBy('snapshot')
            .mapValues(s => ({id: s[0].snapshot, ts: s[0].snapshot, d: s}))
            .values()
            .value();
          ws.send(JSON.stringify({t: 'history', d: historyData, tr: treeId}));
          console.timeEnd('pullHistory');
          break;
        }

        case 'setLanguage':
          console.time('setLanguage');
          userSetLanguage.run(msg.d, userId);
          ws.send(JSON.stringify({t: 'userSettingOk', d: ['language', msg.d]}));
          console.timeEnd('setLanguage');
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
  console.log('ws connection requested');
  const sessionCookie = request.headers.cookie.split(';').find(row => row.trim().startsWith('connect.sid='));
  const sessionId = sessionCookie.split('=')[1];
  const signedCookie = cookieParser.signedCookie(decodeURIComponent(sessionId), config.SESSION_SECRET);
  if (signedCookie === false) {
    socket.destroy();
  } else {
    const session = await new Promise((resolve, reject) => {
      // @ts-ignore
      redis.get(`sess:${signedCookie}`, (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(JSON.parse(data));
        }
      });
    });
    // @ts-ignore
    if (session.user) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        request.session = session;
        console.log('ws connection accepted');
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
  const timestamp = Date.now();
  const confirmTime = didSubscribe ? null : timestamp;
  const trialExpiry = timestamp + 14*24*3600*1000;

  const salt = crypto.randomBytes(16).toString('hex');
  let hash = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest).toString(encoding);
  try {
    let userInsertInfo = userSignup.run(email, salt, hash, timestamp, "trial:" + trialExpiry, "en");
    const user = userByRowId.get(userInsertInfo.lastInsertRowid);

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

        //@ts-ignore
        await nano.request({db: userDbName, method: 'put', path: '/_security', body: {members: {names: [email], roles: []}}});

        let data = _.omit(user, ['id', 'email', 'password', 'salt']);
        data.email = user.id;

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

  // Check SQLite DB for user and password
  let user = userByEmail.get(email);

  if (user !== undefined) {
    crypto.pbkdf2(password, user.salt, iterations, keylen, digest, (err, derivedKey) => {
        if (err) throw err;
        if (derivedKey.toString(encoding) === user.password) {
          // Authentication successful
          try {
            doLogin(req, res, user);
          } catch (loginErr) {
            console.log(loginErr);
          }
        } else {
          res.status(401).send();
        }
    });
  } else {
    // User not found
    res.status(401).send();
  }
});

function doLogin(req, res, user) {
  req.session.regenerate(function(err) {
    if(err) { console.log(err); }

    req.session.user = user.id;

    req.session.save(async (err) => {
      if(err) { console.log(err); }

      let data = _.omit(user, ['id', 'email', 'password', 'salt']);
      data.email = user.id;

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
            const updatedUser = userByEmail.get(tokenRow.email);
            doLogin(req, res, updatedUser);
        } else {
            res.status(404).send();
        }
    } else {
      res.status(404).send();
    }

    // Whether the token is expired or not, delete it from the database
    resetTokenDelete.run(tokenRow.email);
  } catch (err) {
    console.log(err)
    res.status(err.response.status).send(err.response.data);
  }
});



/* ==== DB proxy ==== */

app.use('/db', proxy('http://127.0.0.1:5984', {
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

const stripe = new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15', typescript: true });

app.post('/create-checkout-session', async (req, res) => {
  const { priceId, customer_email } = req.body;

  try {
    // @ts-ignore : docs say to remove 'payment_method_types' but typescript complains
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
      userSetPaymentStatus.run("customer:" + custId, email);

      // Get user's database
      let userDbName = `userdb-${toHex(email)}`;
      let userDb = nano.use(userDbName);

      // Update user's settings
      let settings = {} as SettingsDoc;
      try {
        // @ts-ignore
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
  const trees = req.body;
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
  const index = new URL('../../client/web/index.html', import.meta.url).pathname;
  res.sendFile(index);
});


/* ==== Delta Handlers ==== */

function runDelta(treeId, delta, userId) {
  const ts = delta.ts;

  for (let op of delta.ops) {
    switch (op.t) {
      case 'i':
        runIns(ts, treeId, userId, delta.id, op);
        break;

      case 'u':
        runUpd(ts, delta.id, op);
        break;

      case 'm':
        runMov(ts, delta.id, op);
        break;

      case 'd':
        runDel(ts, delta.id, op);
        break;

      case 'ud':
        runUndel(ts, delta.id);
        break;
    }
  }
}

function runIns(ts, treeId, userId, id, ins )  {
  // To prevent insertion of cards to trees the user shouldn't have access to
  let userTrees = treesByOwner.all(userId);
  if (!userTrees.map(t => t.id).includes(treeId)) {
    throw new Error(`User ${userId} doesn't have access to tree ${treeId}`);
  }

  const parentPresent = ins.p == null || cardById.get(ins.p);
  if (parentPresent) {
    cardInsert.run(ts, id, treeId, ins.c, ins.p, ins.pos, 0);
    //console.log(`Inserted card ${id} at ${ins.p} with ${ins.c}`);
  } else {
    throw new Error('Ins Conflict : Parent not present');
  }
}

function runUpd(ts, id, upd )  {
  const card = cardById.get(id);
  if (card != null && card.updatedAt == upd.e) { // card is present and timestamp is as expected
    cardUpdate.run(ts, upd.c, id);
    //console.log('Updated card ', id, ' to ', JSON.stringify(upd.c));
  } else if (card == null) {
    throw new Error(`Upd Conflict : Card '${id}' not present.`);
  } else if (card.updatedAt != upd.e) {
    throw new Error(`Upd Conflict : Card '${id}' timestamp mismatch : ${card.updatedAt} != ${upd.e}`);
  } else {
    throw new Error(`Upd Conflict : Card '${id}' unknown error`);
  }
}

function runMov(ts, id, mov )  {
  const parentPresent = mov.p == null || cardById.get(mov.p) != null;
  const card = cardById.get(id);
  if(card != null && parentPresent && !isAncestor(id, mov.p)) {
    cardMove.run(ts, mov.p, mov.pos, id);
    //console.log('Moved card ', id, ' to ', mov.p, ' at ', mov.pos);
  } else {
    throw new Error('Mov Conflict : Card not present or parent not present or would create a cycle');
  }
}

function runDel(ts, id, del )  {
  const card = cardById.get(id);
  if (card != null && card.updatedAt == del.e) {
    cardDelete.run(ts, id);
    //console.log('Deleted card ' + id);
  } else if (card == null) {
    throw new Error(`Del Conflict : Card '${id}' not present`);
  } else if (card.updatedAt != del.e) {
    throw new Error(`Del Conflict : Card '${id}' timestamp mismatch : ${card.updatedAt} != ${del.e}`);
  } else {
    throw new Error(`Del Conflict : Card '${id}' unknown error`);
  }
}

function runUndel(ts, id)  {
  const info = cardUndelete.run(id);
  if (info.changes == 0) {
    throw new Error('Undel Conflict : Card not present');
  }
  //console.log('Undeleted card ' + id);
}

// --- Helpers ---


function isAncestor(cardId , targetParentId ) {
  if (targetParentId == null) {
    return false;
  } else if (cardId == targetParentId) {
    return false;
  } else {
    const parent = cardById.get(targetParentId);
    return isAncestor(cardId, parent.parentId);
  }
}


/* === HELPERS === */


const designDocList =
  {
    "_id": "_design/testDocList",
    "views": {
      "docList": {
        "map": "function (doc) {\n  if (/metadata/.test(doc._id)) {\n    emit(doc._id, doc);\n  }\n}"
      }
    },
    "language": "javascript"
  };

interface SettingsDoc {
    _id: string;
    email: string;
    language: string;
    paymentStatus: {trialExpires: number} | { customer : string };
    confirmedAt : number;
}


function defaultSettings(email, language = "en", trialStart, trialLength, confirmedTime:number=null) : SettingsDoc {
  let trialExpires = trialStart + trialLength*24*3600*1000;
  return {_id: "settings", email, language, paymentStatus: {trialExpires}, confirmedAt: confirmedTime};
}


function toHex(str) {
  return Buffer.from(str).toString('hex');
}


function newToken() {
 return URLSafeBase64.encode(uuid.v4(null, new Buffer(16)));
}


function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

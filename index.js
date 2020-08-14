const express = require('express');
const path = require('path');
const axios = require('axios');
const config = require("./config.js");
const nano = require('nano')(`http://${config.COUCHDB_USER}:${config.COUCHDB_PASS}@localhost:5984`);
const usersDB = nano.use("_users");
const promiseRetry = require("promise-retry");
const app = express();
const port = 3000;


app.use(express.json());

app.post('/signup', async (req, res) => {
  let email = req.body.email;
  let userDbName = `userdb-${toHex(email)}`;

  const dbRes = await usersDB.insert(
    { type: "user"
    , roles: []
    , name: email
    , password: req.body.password
    }, `org.couchdb.user:${email}`);

  let loginRes = await axios.post("http://localhost:5984/_session", {
    name: email,
    password: req.body.password
  })

  await promiseRetry((retry, attempt) => {
    return nano.use(userDbName).insert(designDocList).catch(retry);
  }, {minTimeout: 100});

  let data = {name: email, db: userDbName};

  res.status(200).cookie(loginRes.headers['set-cookie']).send(data);
});

app.use(express.static("../client/web"));

app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../client/web/index.html'));
});

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

const express = require('express');
const config = require("./config.js");
const usersDB = require('nano')(`http://${config.COUCHDB_USER}:${config.COUCHDB_PASS}@localhost:5984/_users`);
const app = express();
const port = 3000;


app.use(express.json());

app.post('/signup', async (req, res) => {
  const dbRes = await usersDB.insert(
    { type: "user"
    , roles: []
    , name: req.body.email
    , password: req.body.password
    }, `org.couchdb.user:${req.body.email}`);
  console.log(dbRes);
  res.send(dbRes);
});

app.use(express.static("../client/web"));

app.listen(port, () => console.log(`Example app listening at https://localhost:${port}`));

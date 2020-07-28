const express = require('express');
const config = require("./config.js");
const nanoSecure = require('nano')(`http://${config.COUCHDB_USER}:${config.COUCHDB_PASS}localhost:5984`)
const app = express();
const port = 3000;


app.post('/signup', (req, res) => {

});

app.use(express.static("../client/web"));

app.listen(port, () => console.log(`Example app listening at https://localhost:${port}`));

const express = require('express');
const app = express();
const port = 8080;


app.use(express.static("../client/web"));

app.listen(port, () => console.log(`Example app listening at https://localhost:${port}`));

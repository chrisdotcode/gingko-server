const express = require('express');
const app = express();
const port = 3000;


app.get('/login', (req, res) => res.send('Hello Login'));

app.use(express.static("../client/web"));

app.listen(port, () => console.log(`Example app listening at https://localhost:${port}`));

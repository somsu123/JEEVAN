const { MongoClient } = require('mongodb');

const uri = "mongodb+srv://sumitkumarmishraarcade25_db_user:v7UAyAUOMrCMBFF0@cluster0.wuqns3e.mongodb.net/JEEVAN";

const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    console.log("Connected successfully to server");
    await client.close();
  } catch (err) {
    console.error("Connection failed:", err.message);
  }
}
run();

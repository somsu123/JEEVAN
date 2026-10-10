const { MongoClient } = require('mongodb');

const uri = "mongodb://sumitkumarmishraarcade25_db_user:UcgrBiicFUNLLfQW@ac-yyisute-shard-00-00.uaikg9m.mongodb.net:27017,ac-yyisute-shard-00-01.uaikg9m.mongodb.net:27017,ac-yyisute-shard-00-02.uaikg9m.mongodb.net:27017/JEEVAN?ssl=true&replicaSet=atlas-yyisute-shard-0&authSource=admin&retryWrites=true&w=majority";

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

import { MongoMemoryReplSet } from 'mongodb-memory-server';

// One real mongod replica set for the whole run (transactions need a replica set).
// Set TEST_MONGODB_URI to use an existing one instead, as CI does with its service container.
export default async function setup() {
  if (process.env.TEST_MONGODB_URI) return;
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.TEST_MONGODB_URI = replSet.getUri();
  return () => replSet.stop();
}

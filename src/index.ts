import fs from 'fs';
import path from 'path';

import rp from 'request-promise-native';
import syncRequest from 'sync-request';
import schedule from 'node-schedule';

export interface Config {
  cron?: any[];
  singleRun?: boolean;
  dataPath: string;
  apiURL: string;
  feedURL: string;
  keys: {name: string, location: string}[];
  saveDataCron?: any;
  log?: boolean;
  dryRun?: boolean;
  token?: string;
}

export interface Bus {
  id: string;
  invalidateTime?: Date | string;
  locations: string[];
}

export interface ExternalBus {
  _id: string;
  name?: string;
  locations: string[];
  invalidate_time?: string;
  other_names?: string[];
}

export interface Data {
  lastUpdated: Date | string;
  buses: Record<string, Bus>;
}

export interface Feed {
  version: string;
  encoding: string;
  feed: {
    updated: {$t: string},
    entry: Record<string, {$t: string}>[]
  };
}

interface GenericResponse {
  ok?: boolean;
  error?: string;
}

interface PostResponse extends GenericResponse {
  id?: string;
}

const config: Config = JSON.parse(fs.readFileSync(path.join(__dirname, "../config.json"), "utf8"));

if (!config.dryRun && !config.token) {
  console.log("You are trying to run furry-guacamole without a token.");
  console.log("Stuff will break; you have been warned.\n");
}

const dataPath = path.join(__dirname, "../", config.dataPath);
let data: Data;
try {
  data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  data.lastUpdated = new Date(data.lastUpdated);
  Object.keys(data.buses).forEach(key => {
    let bus = data.buses[key];
    if (bus.invalidateTime) {
      bus.invalidateTime = new Date(bus.invalidateTime);
    }
  });
} catch (e) {
  console.log(`Tried to read data, but got:\n${e.stack}\n\nRebuilding data file...`);
  data = {lastUpdated: new Date(), buses: {}};

  let buses: ExternalBus[] = JSON.parse(syncRequest("GET", config.apiURL + "/buses").getBody("utf8"));
  buses.forEach(bus => {
    if (bus.name) {
      let key = bus.name;
      data.buses[key] = {id: bus._id, locations: bus.locations};
      if (bus.invalidate_time) {
        data.buses[key].invalidateTime = new Date(bus.invalidate_time);
      }
    }
  });

  try {
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.log("Could not write data file. Terminating:")
    throw e;
  }
}

function log(item: any) {
  if (config.log) {
    console.log(item);
  }
}

let dataUpdated = false;
async function saveData() {
  if (dataUpdated) {
    await fs.promises.writeFile(dataPath, JSON.stringify(data, null, 2), "utf8");
    dataUpdated = false;
  }
}

export async function fetchFromGoogleSheets() {
  const feed: Feed = await rp.get(config.feedURL, {json: true});
  let busCache: ExternalBus[];
  log(`Feed last updated at ${feed.feed.updated.$t}`);
  // if (new Date(feed.feed.updated.$t) >= data.lastUpdated) {
    log(`Updating buses...`);
    await feed.feed.entry.reduce<Promise<void>>(async (acc, entry) => {
      await acc;
      await Promise.all(config.keys.map(async (keys) => {
        const name: string = entry[keys.name] && entry[keys.name].$t;
        if (!name) {
          return;
        }

        const location: string = entry[keys.location] && entry[keys.location].$t.toUpperCase();
        log(`=== ${name} @ ${location} ===`);

        let bus = data.buses[name];
        if (!bus) {
          log(`${name} not found, attempting to update internal database`);
          if (!busCache) {
            busCache = await rp.get(config.apiURL + "/buses", {json: true});
          }

          let foundBus = busCache.find(bus => {
            return bus.name === name || (bus.other_names && bus.other_names.includes(name));
          });

          if (foundBus) {
            log(`${name} found, inserting ${foundBus._id} into database`);
            data.buses[name] = {id: foundBus._id, locations: foundBus.locations, invalidateTime: foundBus.invalidate_time && new Date(foundBus.invalidate_time)}
            dataUpdated = true;
          } else if (config.dryRun) {
            log(`${name} not found; skipping bus creation in dry run`);
          } else {
            log(`Creating ${name}...`);
            const response: PostResponse = await rp.post(config.apiURL + "/buses", {json: {
              name,
              available: true
            }, headers: {Authorization: `Basic ${config.token}`}});
            log(`Done creating bus ${name}. ID: ${response.id}`)
            data.buses[name] = {id: response.id, locations: []}
          }
        }
      }));
    }, Promise.resolve());
  // }
}

if (config.cron) {
  config.cron.forEach(rule => {
    schedule.scheduleJob(rule, () => {
      fetchFromGoogleSheets();
      console.log("Fetching...");
    });
  });

  if (config.saveDataCron) {
    schedule.scheduleJob(config.saveDataCron, () => {
      saveData();
      console.log("Saved data.");
    });
  }
} else if (config.singleRun) {
  fetchFromGoogleSheets().then(saveData).then(() => console.log("Saved data."));
}

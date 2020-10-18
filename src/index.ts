import fs from 'fs';
import path from 'path';

import { JSDOM } from 'jsdom';
import rp from 'request-promise-native';
import syncRequest from 'sync-request';
import schedule from 'node-schedule';

export interface Config {
  cron?: any[];
  singleRun?: boolean;
  dataPath: string;
  apiURL: string;
  feedURL: string;
  jsonFeedURL: string;
  saveDataCron?: any;
  log?: boolean;
  dryRun?: boolean;
  token?: string;
}

export interface Bus {
  id: string;
  invalidateTime?: Date | string;
  departure?: number;
  locations: string[];
  available: boolean;
}

export interface ExternalBus {
  _id: string;
  name?: string;
  locations: string[];
  departure?: number;
  invalidate_time?: string;
  other_names?: string[];
  available: boolean;
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
      data.buses[key] = {id: bus._id, locations: bus.locations, available: bus.available};
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

const timeRegex = /(0?[0-9]|1[0-2]):([0-5][0-9]) *(AM|PM)?/;

function parseTime(str: string) {
  const match = timeRegex.exec(str);
  if (match) {
    let hour = parseInt(match[1]);
    const minute = parseInt(match[2]);
    if (match.length < 4) {
      if (hour > 0 && hour < 11) {
        hour += 12; // PM hardcode but it works for now
      }
    } else if (match[3] == "AM") {
      if (hour === 12) {
        hour = 0;
      }
    } else {
      if (hour !== 12) {
        hour += 12;
      }
    }
    return hour * 60 + minute;
  }
}

export async function fetchFromGoogleSheets() {
  const documents = await Promise.all([rp.get(config.feedURL), rp.get(config.jsonFeedURL, {json: true})])
  const { document } = new JSDOM(documents[0]).window;
  const feed: Feed = documents[1];
  let busCache: ExternalBus[];
  let seenBuses: Record<string, boolean> = {};
  log(`Updating buses...`);

  let buses: {name: string, location: string, departure?: number}[] = [];

  feed.feed.entry.forEach(entry => {
    [["gsx$towns", "gsx$loc", "gsx$time"], ["gsx$townsbuslocation", "gsx$loc_2", "gsx$time_2"]].map(keys => {return {name: keys[0], location: keys[1], departure: keys[2]}}).forEach(keys => {
      const name: string = entry[keys.name] && entry[keys.name].$t && entry[keys.name].$t.trim();
      const location: string = entry[keys.location] && entry[keys.location].$t && entry[keys.location].$t.trim().toUpperCase();
      
      let departure: number | undefined;
      if (entry[keys.departure] && entry[keys.departure].$t) {
        departure = parseTime(entry[keys.departure].$t);
      }

      if (name && name.length > 0) {
        seenBuses[name] = true;
        buses.push({name, location: location && location.length > 0 ? location : undefined, departure});
      }
    });
  });

  [...document.getElementsByTagName("tr")].slice(3).map(row => {
    return row.getElementsByTagName("td")
  }).forEach(row => [0, 3].map(index => {
    const name = row[index].textContent.trim();
    if (name.length < 1) {
      return;
    }

    const locationStr = row[index + 1].textContent.trim().toUpperCase();
    let location: string;
    if (locationStr.length > 0) {
      location = locationStr;
    }

    if (!seenBuses[name]) {
      buses.push({name, location, departure: row[index + 2].textContent ? parseTime(row[index + 2].textContent) : undefined});
      seenBuses[name] = true;
    }
  }));

  await buses.reduce<Promise<void>>(async (acc, {name, location, departure}) => {
    await acc;
    log(`=== ${name} @ ${location} (${departure}) ===`);

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
        data.buses[name] = {id: foundBus._id, locations: foundBus.locations, departure: foundBus.departure, invalidateTime: foundBus.invalidate_time && new Date(foundBus.invalidate_time), available: foundBus.available}
        dataUpdated = true;
      } else if (config.dryRun) {
        log(`${name} not found; skipping bus creation in dry run`);
        return;
      } else if (!location) {
        log(`${name} has no location; skipping bus creation`);
        return;
      } else {
        log(`Creating ${name}...`);
        const response: PostResponse = await rp.post(config.apiURL + "/buses", {json: {
          name,
          available: true
        }, headers: {Authorization: `Basic ${config.token}`}});
        log(`Done creating bus ${name}. ID: ${response.id}`)
        data.buses[name] = {id: response.id, locations: [], available: true}
      }

      bus = data.buses[name];
      dataUpdated = true;
    }

    if (!bus.available) {
      console.log(`Marking ${name} as available`);
      bus.available = true;

      if (!config.dryRun) {
        await rp.patch(config.apiURL + "/buses/" + bus.id, {json: {available: true}, headers: {Authorization: `Basic ${config.token}`}});
      }

      dataUpdated = true;
    }

    if (typeof departure !== "undefined") {
      if (bus.departure !== departure) {
        log(`Setting ${name}'s departure to ${departure}.`);
        bus.departure = departure;
        const url = config.apiURL + "/buses/" + bus.id + "/departure";
        if (config.dryRun) {
          log(`Will PUT ${url}.`);
        } else {
          await rp.put(url, {json: {departure}, headers: {Authorization: `Basic ${config.token}`}});
        }
      }
    }

    if (location) {
      if (bus.locations[0] !== location) {
        log(`Setting ${name}'s location to ${location}.`);

        const now = new Date();
        bus.locations = [location];
        bus.invalidateTime = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);

        const url = config.apiURL + "/buses/" + bus.id + "/location";
        if (config.dryRun) {
          log(`Will PUT ${url}.`);
        } else {
          await rp.put(url, {json: {locations: bus.locations, invalidate_time: bus.invalidateTime, source: "google_sheets", associate_time: true}, headers: {Authorization: `Basic ${config.token}`}});
        }

        dataUpdated = true;
      }
    } else if (bus.locations.length !== 0) {
      log(`Resetting ${name}'s location.`);

      const now = new Date();
      bus.locations = [];
      bus.invalidateTime = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);

      const url = config.apiURL + "/buses/" + bus.id + "/location";
      if (config.dryRun) {
        log(`Will PUT ${url}.`);
      } else {
        await rp.put(url, {json: {locations: bus.locations, invalidate_time: bus.invalidateTime, source: "google_sheets"}, headers: {Authorization: `Basic ${config.token}`}});
      }

      dataUpdated = true;
    }
  }, Promise.resolve());

  await Promise.all(Object.keys(data.buses).filter(key => !seenBuses[key]).map(async (key) => {
    if (data.buses[key].available) {
      console.log(`Marking ${key} as unavailable`);
      data.buses[key].available = false;
      if (!config.dryRun) {
        await rp.patch(config.apiURL + "/buses/" + data.buses[key].id, {json: {available: false}, headers: {Authorization: `Basic ${config.token}`}});
      }
      dataUpdated = true;
    }
  }));
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

const cameras = require('./cameras.js');
const keys = require('./keys.js');
const {
  compressGIF,
  isRushHour,
  makePost,
  sleep,
} = require('./util.js');

const Path = require('path');
const Axios = require('axios');
const Fs = require('fs-extra');
const _ = require('lodash');
const { v4: uuidv4 } = require('uuid');
const GIFEncoder = require('gifencoder');
const {
  createCanvas,
  loadImage,
} = require('canvas');
const sizeOf = require('image-size');
const argv = require('minimist')(process.argv.slice(2));
const Twitter = require('twitter');

const assetDirectory = `./assets-${uuidv4()}/`;
const pathToGIF = `${assetDirectory}camera.gif`;
let chosenCamera;
const numImages = 10;

let client; 

const downloadImage = async (index) => {
  const path = Path.resolve(__dirname, `${assetDirectory}camera-${index}.jpg`);
  const writer = Fs.createWriteStream(path)

  const response = await Axios({
    url: chosenCamera.url,
    method: 'GET',
    responseType: 'stream'
  });

  return new Promise(resolve => response.data.pipe(writer).on('finish', resolve));
};

const downloadCamera = async (id) => {
  const headers = {
    'Authorization': 'APIKEY ' + keys.ohgo_key,
  };
  const params = {
    'page-all': true,
  };
  const formattedCamera = {};

  if (_.isUndefined(id)) {
    const response = await Axios.get('https://publicapi.ohgo.com/api/v1/cameras', { headers, params });
    const ohgoCamera = _.sample(response.data.results);

    formattedCamera.id = ohgoCamera.id;
    formattedCamera.name = ohgoCamera.location;

    // a camera can have multiple directions (W, N, E, S), just choose one
    formattedCamera.url = _.sample(ohgoCamera.cameraViews).largeUrl;
  }
  else {
    const response = await Axios.get(`https://publicapi.ohgo.com/api/v1/cameras/${id}`, { headers });
    const ohgoCamera = response.data.results[0];
    console.log(ohgoCamera)
    formattedCamera.id = ohgoCamera.id;
    formattedCamera.name = ohgoCamera.location;

    // a camera can have multiple directions (W, N, E, S), just choose one
    formattedCamera.url = _.sample(ohgoCamera.cameraViews).largeUrl;
  }

  return formattedCamera;
};

const start = async () => {
  // Get Twitter API keys
  if (_.isUndefined(argv.location)) {
    console.log("Location must be passed in");
    return;
  }

  client = new Twitter({
    consumer_key: keys[argv.location].consumer_key,
    consumer_secret: keys[argv.location].consumer_secret,
    access_token_key: keys[argv.location].access_token,
    access_token_secret: keys[argv.location].access_token_secret,
  });

  if (!_.isUndefined(argv.api)) {
    // download ohio camera from API

    console.log("Choose camera from OHGO API");
    chosenCamera = await downloadCamera(argv.id);
  }
  else if (!_.isUndefined(argv.id)) {
    // local camera by ID
    chosenCamera = _.find(cameras, { id: argv.id });
  }
  else if (isRushHour()) {
    // local camera that has rush hour priority
    console.log("Rush Hour priority...\n");
    chosenCamera = _.sample(_.pickBy(cameras, { 'rushHourPriority': true }));
  }
  else {
    // random local camera
    chosenCamera = _.sample(cameras);
  }

  console.log(`ID ${chosenCamera.id}: ${chosenCamera.name}\n`);

  if (_.isUndefined(chosenCamera))
    return;

  Fs.ensureDirSync(assetDirectory);

  console.log("Downloading traffic camera images...");
  // Retrieve 10 images from chosen traffic camera
  const delay = chosenCamera.delay ? chosenCamera.delay * 1000 : 6000;

  for (let i = 0; i < numImages; i++) {
    await downloadImage(i);

    // Cameras refresh every few seconds, so wait until querying again
    if (i < numImages - 1)
      await sleep(delay);
  }
  console.log("Download complete\n");
  
  createGIF();
};

const createGIF = async () => {
  const pathToFirstImage = Path.resolve(`${assetDirectory}camera-0.jpg`);
  const dimensions = sizeOf(pathToFirstImage);
  const encoder = new GIFEncoder(dimensions.width, dimensions.height);
  const canvas = createCanvas(dimensions.width, dimensions.height);
  const ctx = canvas.getContext('2d');

  console.log("Generate GIF...")

  encoder.start();
  encoder.setRepeat(0);   // 0 for repeat, -1 for no-repeat
  encoder.setDelay(150);  // frame delay in ms
  encoder.setQuality(5); // image quality. 10 is default.

  for (let i = 0; i < numImages; i++) {
    const image = await loadImage(`${assetDirectory}camera-${i}.jpg`);
    ctx.drawImage(image, 0, 0, dimensions.width, dimensions.height);
    encoder.addFrame(ctx);
  }
  
  encoder.finish();

  Fs.writeFileSync(`${assetDirectory}camera.gif`, encoder.out.getData());

  console.log("GIF generated\n")

  if (Fs.statSync(pathToGIF).size > 5100000) {
      // Twitter GIF files must be less than 5MB
      // We'll compress the GIF once to attempt to get the size down
    console.log("GIF is too big, Compressing...")
    await compressGIF(pathToGIF, assetDirectory);
    console.log("GIF compressed\n")
  }

    tweet();
};

// Taken from https://github.com/desmondmorris/node-twitter/tree/master/examples#chunked-media

/**
   * Step 1 of 3: Initialize a media upload
   * @return Promise resolving to String mediaId
   */
const initUpload = () => {
  const mediaType = "image/gif";
  const mediaSize = Fs.statSync(pathToGIF).size;

  console.log("Start tweet upload")

  return makePost('media/upload', client, {
    command    : 'INIT',
    total_bytes: mediaSize,
    media_type : mediaType,
  }).then(data => data.media_id_string);
};

/**
 * Step 2 of 3: Append file chunk
 * @param String mediaId    Reference to media object being uploaded
 * @return Promise resolving to String mediaId (for chaining)
 */
const appendUpload = (mediaId) => {
  const mediaData = Fs.readFileSync(pathToGIF);

  return makePost('media/upload', client, {
    command      : 'APPEND',
    media_id     : mediaId,
    media        : mediaData,
    segment_index: 0
  }).then(data => mediaId);
};
 
/**
 * Step 3 of 3: Finalize upload
 * @param String mediaId   Reference to media
 * @return Promise resolving to mediaId (for chaining)
 */
const finalizeUpload = (mediaId) => {
  return makePost('media/upload', client, {
    command : 'FINALIZE',
    media_id: mediaId
  }).then(data => mediaId);
};

const publishStatusUpdate = (mediaId) => {
  return makePost('statuses/update', client, {
      status: chosenCamera.name,
      media_ids: mediaId
    });
};

const cleanup = () => {
  if ((!_.isUndefined(argv.persist) && argv.persist !== true) || (_.isUndefined(argv.persist))) {
    Fs.removeSync(assetDirectory);
    console.log(assetDirectory + " removed")
  }
};

const tweet = () => {
  initUpload()                 // Declare that you wish to upload some media
    .then(appendUpload)        // Send the data for the media
    .then(finalizeUpload)      // Declare that you are done uploading chunks
    .then(publishStatusUpdate) // Make tweet containing uploaded gif
    .finally(cleanup);         // Remove downloaded images and generated gif
};

start();

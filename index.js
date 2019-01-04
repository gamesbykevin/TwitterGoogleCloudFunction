//twitter library reference
const Twit = require('twit');

//used to connect to the database
const Firestore = require('@google-cloud/firestore');

//object used to send emails
const nodemailer = require('nodemailer'); 

//project id where we our db is
const myProjectId = process.env.myProjectId;

//our firestore reference so we can authenticate connecting
const firestore = new Firestore({
	projectId: myProjectId
});

//endpoints to perform our actions
const endpointFollowers = 'followers/ids';
const endpointFollowing = 'friends/ids';
const endpointFollow 	= 'friendships/create';
const endpointUnfollow 	= 'friendships/destroy';
const endpointLike 		= 'favorites/create';
const endpointTimeline 	= 'statuses/user_timeline';

//where we will store our data
const tableName = "twitter-meta-data";

//id where we store the last app run time
const lastRunId = 1;

//where we will store users that we want to ignore
const ignoreUserId = 2;

//list of our followers
var listFollowers = [];

//list of following
var listFollowing = [];

//list of people we are going to ignore
var listIgnore = [];

//how many user ids are we allowed to store in each document
var ignoreUserIdsPerDocument = parseInt(process.env.ignoreUserIdsPerDocument);

//how many users can we follow each time this app runs
const followLimit = parseInt(process.env.followLimit);

//how many users can we unfollow each time this app runs
const unfollowLimit = parseInt(process.env.unfollowLimit);

//our twitter credentials
const consumer_key 		  = process.env.consumer_key;
const consumer_secret 	  = process.env.consumer_secret;
const access_token 		  = process.env.access_token;
const access_token_secret = process.env.access_token_secret;

//our twitter account name
const username = process.env.username;

//how long to wait for our app to run again used to prevent exceeding account limits (in milliseconds)
const delay = parseInt(process.env.delay);

//smtp server credentials
const smtpUsername = process.env.smtpUsername;
const smtpPassword = process.env.smtpPassword;

//who do we notify our summary
const notify = process.env.notify;

//our twitter reference object
const twitter = new Twit({
  consumer_key:         consumer_key,
  consumer_secret:      consumer_secret,
  access_token:         access_token,
  access_token_secret:  access_token_secret,
  timeout_ms:           60 * 1000,  // optional HTTP request timeout to apply to all requests.
  strictSSL:            true,       // optional - requires SSL certificates to be valid.
});

/**
 * Responds to any HTTP request.
 *
 * @param {!express:Request} req HTTP request context.
 * @param {!express:Response} res HTTP response context.
 */
exports.runAgent = (req, res) => {
    
	//obtain the keyId from the query string
	const keyId = req.query.keyId;

	//notify the key provided
	console.log("Key provided: " + keyId);

	//make sure correct key specified to invoke function
	if (keyId != null && keyId.length > 30 && keyId == process.env.keyId) {

		//print valid key id
		console.log("Key Id valid");

		//execute the process
		runCustomAgent(res);
		
	} else {

		//someone tried to access without a valid key
		console.log("Invalid key provided");
		res.status(200).send('Done');
	}
};

//query the database to load our list of ignored users
async function loadListIgnore() {
	
	console.log('loading our ignored users list from database');
	
	//reference our db
	const dbRef = await firestore.collection(tableName);
	
	//start our list as empty
	listIgnore = [];
	
	//query the table and return the results in our snapshot
	var snapshot = await dbRef.where('id', '==', ignoreUserId).get();
	
	if (snapshot.docs.length < 1) {
		console.log('there are no ignored users in our list');
	} else {
		
		//check every result to create our list
		for (var index = 0; index < snapshot.docs.length; index++) {
			listIgnore = listIgnore.concat(snapshot.docs[index].data().userIds.split(','));
		}
	}
	
	console.log(listIgnore.length.toLocaleString() + ' ignored user ids loaded')
}

//update list of ignored user ids in the database
async function updateIgnoredDB() {
	
	//reference our db
	const dbRef = await firestore.collection(tableName);
	
	//query the table and return the results in our snapshot
	var snapshot = await dbRef.where('id', '==', ignoreUserId).get();
	
	console.log('saving new user id data');
	
	var userIds = '';
	
	//keep track everytime we add a userId
	var newDataCount = 0;
	
	//keep track of existing data
	var existingDataCount = 0;
	
	for (var index = 0; index < listIgnore.length; index++) {
		
		if (userIds.length > 0)
			userIds = userIds + ',';
		
		userIds = userIds + listIgnore[index];
		
		//add 1 to the count
		newDataCount = newDataCount + 1;
		
		//if we reached the max allowed or are at the end of our list, save it in the db
		if (newDataCount >= ignoreUserIdsPerDocument || index >= listIgnore.length - 1) {
			
			//reset the count to 0
			newDataCount = 0;
			
			var result;
			
			//if we don't have any existing data or we already updated what's available we will add a new document here
			if (snapshot.docs.length < 1 || existingDataCount >= snapshot.docs.length) {
	
				console.log('saved new user data to a new document');
	
				//add data to database
				result = await dbRef.add({
					id: ignoreUserId, 
					userIds: userIds
				});
				
			} else {
								
				console.log('updated existing document');
								
				result = await dbRef.doc(snapshot.docs[existingDataCount].id).update({
					userIds: userIds
				});
				
				//after update keep track of our existing data in firestore
				existingDataCount = existingDataCount + 1;
				
			}
			
			console.log(result);
			
			//reset the list to an empty string
			userIds = '';
		}
	}
}

//has enough time passed to run this application again
async function canExecute() {
	
	console.log('retrieving timestamp from db');
	
	//reference our db
	const dbRef = await firestore.collection(tableName);
	
	//query the table and return the results in our snapshot
	var snapshot = await dbRef.where('id', '==', lastRunId).get();
	
	if (snapshot.docs.length < 1) {
		
		console.log('there is no time stored in the database');
		
		//if there is no record we can run the bot again
		return true;
		
	} else {
		
		//retrieve the timestamp from the database to see how much time has passed
		const lapsed = parseInt(new Date().getTime()) - parseInt(snapshot.docs[0].data().timestamp);
		
		console.log(parseInt(lapsed / 1000).toLocaleString() + ' seconds lapsed');
		console.log((delay / 1000).toLocaleString() + ' seconds required');
		
		//if enough time has passed return true
		return (lapsed >= delay);
	}
}

//update run time in database
async function updateDB() {
	
	console.log('updating tableName: ' + tableName + ', lastRunId: ' + lastRunId);
	
	//reference our db
	const dbRef = await firestore.collection(tableName);
	
	//query the table and return the results in our snapshot
	var snapshot = await dbRef.where('id', '==', lastRunId).get();
	
	//current time
	const timestamp = new Date().getTime();
	
	if (snapshot.docs.length < 1) {
		
		//if there are no results we will add
		var result = await dbRef.add({
			id: lastRunId, 
			timestamp: timestamp
		});
		
		console.log('Time added: ' + timestamp);
		
	} else {
		
		//if exists we will update
		var result = await dbRef.doc(snapshot.docs[0].id).update({
			timestamp: timestamp
		});
		
		console.log('Time updated: ' + timestamp);
	}
}

//make api call to populate our follower / following lists
async function populateUsers(following) {

	//is this the first time retrieving data
	var init = true;
	
	//is there another page
	var next_cursor = 0;
	
	//the endpoint is different if we want our followers or friends
	var endpoint = (following) ? endpointFollowing : endpointFollowers;

	//make sure list starts empty before we start populating
	if (following) {
		listFollowing = [];
	} else {
		listFollowers = [];
	}
		
	console.log('querying twitter endpoint: ' + endpoint);
	
	//continue until there are no more pages
	while (true) {
		
		var obj;
		
		if (init) {
			obj = await twitter.get(endpoint, { screen_name: username});
			init = false;
		} else {
			obj = await twitter.get(endpoint, { screen_name: username, cursor: next_cursor });
		}
		
		//concatenate the arrays
		if (following) {
			listFollowing = listFollowing.concat(obj.data.ids);
		} else {
			listFollowers = listFollowers.concat(obj.data.ids);
		}
		
		//are there any more pages?
		next_cursor = parseInt(obj.data.next_cursor);
		
		console.log(obj.data.ids.length + ' users found, next_cursor: ' + next_cursor);
		
		//if there are no more pages, exit loop
		if (next_cursor <= 0)
			break;
	}
}

//follow / unfollow users accordingly
async function updateUsers(follow) {
	
	//keep track of our successes
	var countSuccess = 0;
		
	//keep track of our attempts
	var countAttempts = 0;
	
	//what is our limit?
	var limit = (follow) ? followLimit : unfollowLimit;
	
	//check every element in this list to see if it exists in the base list
	var listFind  = (follow) ? listFollowers : listFollowing;
	
	//the base list that will be checked for elements
	var listBase = (follow) ? listFollowing : listFollowers;
	
	//which endpoint?
	var endpoint = (follow) ? endpointFollow : endpointUnfollow;
	
	//list of users we want to try and perform an action against
	var listAction = [];

	//how many users are we currently ignoring?
	var ignoreSize = listIgnore.length;
	
	//look at our find list to see if any elements exist in the base list
	for (var index = 0; index < listFind.length; index++) {
		
		//user id we want to search for in the base list
		var userId = listFind[index];
		
		//search our following list to see if we are already following them
		var found = false;
		
		//check every element for match
		for (var i = 0; i < listBase.length; i++) {
			
			if (listBase[i] == userId) {
				found = true;
				break;
			}
		}
		
		//if the user was not found in the list add it to the action list accordingly
		if (!found) {
			
			if (follow) {

				//if we are following, and this user isn't part of the ignore list, then we can add it to the action list
				if (!hasIgnoreUserId(userId))
					listAction.push(userId);
				
			} else {
				
				//if we are unfollowing, and this user isn't part of the ignore list, let's add it to the ignore list
				if (!hasIgnoreUserId(userId))
					listIgnore.push(userId);
				
				listAction.push(userId);
			}
		}
	}
	
	//only attempt so many times
	while (countAttempts < limit && listAction.length > 0) {
		
		//keep track of our # of attempts
		countAttempts = countAttempts + 1;
		
		//pick random index
		var index = parseInt(Math.random() * listAction.length);
		
		//pick random user id from list
		var userId = listAction[index];
		
		//now remove that element so we don't pick it again
		listAction.splice(index, 1);
		
		if (follow) {
			console.log('following (' + countAttempts + '): ' + userId);
		} else {
			console.log('unfollowing (' + countAttempts + '): ' + userId);
		}
		
		try {
			
			//follow the user
			var result = await twitter.post(endpoint, { id: userId });
			
			//keep track of how many people we followed successfully
			countSuccess = countSuccess + 1;
			
			//what was the result
			console.log(result);
			
		} catch (error) {
			console.log(error);
		}
	}
	
	//if we are unfollowing users
	if (!follow) {
		
		//if the size of our ignore list changed, update our database with that data
		if (ignoreSize != listIgnore.length) {
			console.log('we found more users to ignore');
			await updateIgnoredDB();
		} else {
			console.log('we dont have any additional users to ignore');
		}
	}
	
	if (follow) {
		return 'followed ' + countSuccess + ' of ' + listAction.length.toLocaleString();
	} else {
		return 'unfollowed ' + countSuccess + ' of ' + listAction.length.toLocaleString();
	}	
}

function hasIgnoreUserId(userId) {
	
	for (var index = 0; index < listIgnore.length; index++) {
		
		if (listIgnore[index] == userId)
			return true;
	}
	
	//we didn't find it in the array list, return false
	return false;
}

//look at our latest tweet and "like" it if it isn't already
async function likeTweet() {
	
	console.log('Retrieving latest tweet for "' + username + '"');
	
	//retrieve our latest tweet
	const tweet = await twitter.get(endpointTimeline, { screen_name: username, count: 1 });
	
	console.log(tweet.data[0]);
	
	//get the id of the tweet
	const tweetId = tweet.data[0]['id_str'];
	
	//did we already like this tweet?
	const liked = (JSON.stringify(tweet.data[0]['favorited']).toLowerCase().indexOf("true") > -1);
	
	//what is our result
	console.log('Tweet id: ' + tweetId);
	console.log('Liked: ' + liked);
	
	//if the tweet isn't liked, let's like it now
	if (!liked) {
		console.log('liking tweet');
		const response = await twitter.post(endpointLike, {id: tweetId});
		console.log(response);
	} else {
		console.log('tweet already liked');
	}
}

async function sendEmail(subject, body) {
	
	//if we don't have info provided we can't send an email
	if (smtpUsername == null || smtpUsername.length < 5)
		return;
	if (smtpPassword == null || smtpPassword.length < 5)
		return;
	if (notify == null || notify.length < 5)
		return;
	
	var transporter = nodemailer.createTransport({
		
		service: 'gmail',
		auth: {
			user: smtpUsername,
			pass: smtpPassword
		}
		
	});

	var mailOptions = {
		from: smtpUsername,
		to: notify,
		subject: subject,
		html: body
	};

	console.log('sending email');
	
	transporter.sendMail(mailOptions, function(error, info) {
		if (error) {
			console.log(error);
		} else {
			console.log('Email sent: ' + info.response);
		}
	});
}

async function runCustomAgent(res) {
	
	//if we can't execute, return
	if (!await canExecute()) {
		console.log('not enough time has lapsed to run again');
		
		if (res != null)
			res.status(200).send('Done');
		
		return;
	}
	
	try {
		
		//load our list of ignored users
		await loadListIgnore();
		
		//like our latest tweet
		await likeTweet();
		
		//populate the users we are following
		await populateUsers(true);
		
		//populate the users following us
		await populateUsers(false);
		
		//construct our status update
		const statusFollowers = 'Followers: ' + listFollowers.length.toLocaleString();
		const statusFollowing = 'Following: ' + listFollowing.length.toLocaleString();
		
		//unfollow users who aren't following us first
		const statusUnfollowed = await updateUsers(false);
		
		//then follow users who are following us
		const statusFollowed = await updateUsers(true);
		
		const statusIgnored = 'Ignoring: ' + listIgnore.length.toLocaleString();
		
		//construct our html body
		const body = statusFollowing + '<br>' + statusFollowers + '<br>' + statusIgnored + '<br><br>' + statusFollowed + '<br>' + statusUnfollowed;
		
		//send email summary
		await sendEmail('Twitter Update', body);
		
	} catch (error) {
		
		console.log(error);
		
	} finally {
		
		//regardless of result, we will update the last run time in the database
		await updateDB();
		
	}

	/*
	//set up your search parameters
	var params = {
	  q: '#gamedev',
	  count: 10,
	  result_type: 'recent',
	  lang: 'en'
	};

	//perform our search with the specified parameters
	const results = await twitter.get('search/tweets', params);	
	*/
	
	if (res != null)
		res.status(200).send('Done');
	
	console.log('Done');
}

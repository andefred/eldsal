const express = require("express");
const router = express.Router();
const stripe_membfee = require('stripe')(process.env.REACT_APP_STRIPE_PRIVATE_KEY_ELDSAL_ORG);
const stripe_housecard = require('stripe')(process.env.REACT_APP_STRIPE_PRIVATE_KEY_ELDSAL_AB);
const utils = require("./utils");
const response = require("./response");
const middleware = require("./middleware");
const auth0 = require("./auth0");
const stripe = require("./stripe");

module.exports = router;

const { returnError, badRequest, internalServerError } = response;
const { stringCompare, getDateString, getNormalizedAmount } = utils;
const { checkJwt, checkLoggedInUser, checkUserIsAdmin, checkUserIsDeveloper } = middleware;
const { getManagementClient, userHasRole, isUserInCurrentConnection, getUserClientObject } = auth0;


/*
 * ROUTES
 */


// TEST: This route doesn't need authentication
router.get('/public', function (req, res) {
    res.json({
        message: 'Hello from a public endpoint! You don\'t need to be authenticated to see this.'
    });
});

// TEST: This route needs authentication
router.get('/private', checkJwt, async function (req, res) {
    res.json({
        message: 'Hello from a private endpoint! You need to be authenticated to see this.'
    });
});

router.get('/getLoggedInUser', checkJwt, async function (req, res) {
    console.log('getLoggedInUser');

    if (!req.user || !req.user.sub)
        returnError(res, "No logged in user", 401);

    const userId = req.user.sub;

    const params = { id: userId };

    getManagementClient()
        .getUser(params)
        .then(function (user) {
            res.json(getUserClientObject(user));
        })
        .catch(function (err) {
            // Handle error.
            console.error(err);
            returnError(res, err);
        });
});

/* Update a user
 * Argument object:
 *  given_name
 *  family_name
 *  birth_date
 *  phone_number
 *  address_line_1
 *  address_line_2
 *  postal_code
 *  city
 *  country
 **/
router.patch('/updateUserProfile/:userId', checkJwt, checkLoggedInUser, async function (req, res) {

    console.log('updateUserProfile');

    const userId = req.params.userId;

    console.log(userId);

    auth0.updateUserProfile(userId, req)
        .then(function (user) {
            res.json();
        })
        .catch(function (err) {
            // Handle error.
            console.error(err);
            returnError(res, err);
        });
});

/* Get an URL to change a user's password (by creating a change password ticket in Auth0)
 * Argument object:
 *  current_password
 *  new_password
 *  verify_password
 **/
router.get('/getChangeUserPasswordUrl/:userId', checkJwt, async function (req, res) {

    console.log('changeUserPassword');

    const params = {
        result_url: `https://${process.env.WEB_HOST}/login`,
        user_id: req.params.userId
    }

    getManagementClient()
        .createPasswordChangeTicket(params)
        .then(function (ticketResponse) {
            res.json({ url: ticketResponse.ticket });
        })
        .catch(function (err) {
            // Handle error.
            console.error(err);
            returnError(res, err);
        });

});

/** ADMIN */


/* Get users
 **/
router.get('/admin/get-users', checkJwt, checkUserIsAdmin, async function (req, res) {

    console.log('admin/get-users');

    auth0.getManagementClient()
        .getUsers()
        .then(function (users) {
            // Filter out only users from the connection specified in the env file
            res.json(users.filter(user => isUserInCurrentConnection(user)).map(user => getUserClientObject(user)).sort((a, b) => stringCompare(a.name, b.name)));
        })
        .catch(function (err) {
            // Handle error.
            console.error(err);
            returnError(res, err);
        });

});

/* Export users as CSV file
 **/
router.get('/admin/export-users', checkJwt, checkUserIsAdmin, async function (req, res) {

    console.log('admin/export-users');

    auth0.exportUsers()
        .then(fileContent => {
            res.status(200).contentType("text/csv").attachment("EldsalMemberList.csv").send(fileContent);
        },
        error => {
            console.error(error);
            returnError(res, error);
        });
});

/* Update membership fee payment for user
 * Argument object:
 *  payed: boolean
 *  method: string ("manual" | "stripe")
 *  payedUntil: date (YYYY-MM-DD)
 *  amount: number (yearly amount)
 **/
router.patch('/admin/update-user-membership/:userId', checkJwt, checkUserIsAdmin, async function (req, res) {

    console.log('admin/update-user-membership');

    const userId = req.params.userId;
    console.log(userId);

    auth0.adminUpdateUserFee(utils.fee_flavour_membership, userId, req)
        .then(userClientObject => {
            res.json(userClientObject);
        })
        .catch(function (err) {
            // Handle error.
            console.error(err);
            internalServerError(res, err);
        });
});

/* Update housecard fee payment for user
 * Argument object:
 *  payed: boolean
 *  method: string ("manual" | "stripe")
 *  payedUntil: date (YYYY-MM-DD)
 *  amount: number (monthly amount, regardless of the period actually payed)
 **/
router.patch('/admin/update-user-housecard/:userId', checkJwt, checkUserIsAdmin, async function (req, res) {

    console.log('admin/update-user-housecard');

    const userId = req.params.userId;
    console.log(userId);

    auth0.adminUpdateUserFee(utils.fee_flavour_housecard, userId, req)
        .then(userClientObject => {
            res.json(userClientObject);
        })
        .catch(function (err) {
            // Handle error.
            console.error(err);
            internalServerError(res, err);
        });
});



/** Get a list of Stripe subscriptions */
router.get('/admin/get-subscriptions', checkJwt, checkUserIsAdmin, async (req, res) => {

    console.log('admin/get-subscriptions');

    stripe.getStripeSubscriptions()
        .then(users => res.json(users))
        .catch(function (err) {
            // Handle error.
            console.error(err);
            internalServerError(res, err);
        });
});

/** Cancel a Stripe subscription for membership */
router.patch('/admin/cancel-subscription-membfee/:subscriptionId', checkJwt, checkUserIsAdmin, async (req, res) => {

    console.log('admin/cancel-subscription-membfee');

    const subscriptionId = req.params.subscriptionId;
    console.log(subscriptionId);

    stripe.cancelStripeSubscription(utils.fee_flavour_membership, subscriptionId)
        .then(
            success => res.json(),
            error => returnError(res, error),
        );
});

/** Cancel a Stripe subscription for housecard */
router.patch('/admin/cancel-subscription-housecard/:subscriptionId', checkJwt, checkUserIsAdmin, async (req, res) => {

    console.log('admin/cancel-subscription-housecard');

    const subscriptionId = req.params.subscriptionId;
    console.log(subscriptionId);

    stripe.cancelStripeSubscription(utils.fee_flavour_housecard, subscriptionId)
        .then(
            success => res.json(),
            error => returnError(res, error),
        );
});

router.get('/user-subscriptions', checkJwt, async (req, res) => {

    console.log('user-subscriptions');

    const userId = req.user.sub;

    console.log(userId);

    stripe.getStripeSubscriptionsForUser(userId)
        .then(data => {
            res.json(data);
        })
});



router.get('/subscriptions', checkJwt, async (req, res) => {
    /*
    const user = await getManagementClient().getUser({ id: req.user.sub });

    const membfeeResponse = await getStripeClient("membfee").subscriptions.list({ customer: user.app_metadata.stripe_customer_membfee });
    const housecardResponse = await getStripeClient("housecard").subscriptions.list({ customer: user.app_metadata.stripe_customer_housecard });

    res.json({ membfeeSubs: membfeeResponse.data, housecardSubs: housecardResponse.data });
    */
    res.json({ membfeeSubs: [], housecardSubs: [] });
});

router.get('/prices', checkJwt, async (req, res) => {

    const flavour = req.query.flavour;

    stripe.getPrices(flavour)
        .then(data => res.json(data));
});

router.get('/check-stripe-session', checkJwt, async (req, res) => {

    console.log('check-stripe-session');

    const flavour = req.query.flavour;
    const userId = req.user.sub;

    await stripe.checkStripeSession(flavour, userId);
    res.json({});
});

router.post('/create-checkout-session', checkJwt, async (req, res) => {

    console.log('create-checkout-session');

    const flavour = req.query.flavour;
    const price = req.query.price;
    const userId = req.user.sub;

    console.log(price);

    const sessionId = await stripe.createCheckoutSession(flavour, userId, price);

    res.json({ id: sessionId });
});

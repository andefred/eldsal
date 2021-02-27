const express = require("express");
const router = express.Router();
const jwt = require('express-jwt');
const jwtAuthz = require('express-jwt-authz');
const jwksRsa = require('jwks-rsa');
const { AuthenticationClient, ManagementClient } = require('auth0');
const stripe = require('stripe')(process.env.REACT_APP_STRIPE_PRIVATE_KEY_ELDSAL_ORG);
const stripe_membfee = require('stripe')(process.env.REACT_APP_STRIPE_PRIVATE_KEY_ELDSAL_ORG);
const stripe_housecard = require('stripe')(process.env.REACT_APP_STRIPE_PRIVATE_KEY_ELDSAL_AB);
const { Parser } = require('json2csv');

module.exports = router;

/*
 * FUNCTIONS
 */

/**
 * Return an error response. The error message is included in the response body as JSON.
 * @param {any} res
 * @param {any} statusMessage
 * @param {any} statusCode
 */
function returnError(res, statusMessage, statusCode = 500) {
    console.error(`ERROR ${statusCode}: ${statusMessage}`);
    res.status(statusCode).json({ error: statusMessage });
}

/**
 * Return an error response as Bad Request (400). The error message is included in the response body as JSON.
 * @param {any} res
 * @param {any} statusMessage
 * @param {any} statusCode
 */
function badRequest(res, statusMessage) {
    returnError(res, statusMessage, 400);
}

/**
 * Return an error response as Internal Server Error (500). The error message is included in the response body as JSON.
 * @param {any} res
 * @param {any} statusMessage
 * @param {any} statusCode
 */
function internalServerError(res, statusMessage) {
    returnError(res, statusMessage, 500);
}

/**
 * Check if a user has a specific role.
 * The roles are read from the "roles" property in the users "app_metadata" collection in Auth0.
 * Multiple roles are separated by comma
 * @param {any} user Auth0 user object
 * @param {any} roleName
 */
const userHasRole = (user, roleName) => {

    if (user && user.app_metadata) {
        const roles = user.app_metadata.roles;

        if (!roles)
            return false;

        return roles.replace(/ /g, "").split(",").includes(roleName);
    }
    else {
        return false;
    }
}

/**
 * If the user belongs to the current user "connection", i.e. the Auth0 database corresponding to the current environment (specified in the AUTH0_USER_CONNECTION environment variable)
 * @param {any} user Auth0 user object
 */
const isUserInCurrentConnection = (user) => {
    if (user.identities) {
        return user.identities.filter(identity => identity.provider = "auth0" && identity.connection == process.env.AUTH0_USER_CONNECTION).length > 0;
    }
    else {
        return false;
    }
}

/**
 * Get an Auth0 management client
 * Docs: https://auth0.github.io/node-auth0/module-management.ManagementClient.html
 */
const getManagementClient = () => {
    return new ManagementClient({
        domain: process.env.AUTH0_MGT_DOMAIN,
        clientId: process.env.AUTH0_MGT_CLIENT_ID,
        clientSecret: process.env.AUTH0_MGT_CLIENT_SECRET,
        scope: 'read:users update:users'
    });
}

// Compare strings alphabetically
const stringCompare = (a, b) => {
    var nameA = a == null ? "" : a.toUpperCase(); // ignore upper and lowercase
    var nameB = b == null ? "" : b.toUpperCase(); // ignore upper and lowercase
    if (nameA < nameB) {
        return -1;
    }
    if (nameA > nameB) {
        return 1;
    }
    // names must be equal
    return 0;
};

/**
 * Given an Auth0 user, make a JSON object to pass to client
 * @param {any} user
 */
const getUserClientObject = (user, includePayments = true) => {
    var obj = {}

    obj.user_id = user.user_id;
    obj.picture = user.picture;
    obj.name = user.name;
    obj.given_name = user.given_name;
    obj.family_name = user.family_name;
    obj.email = user.email;

    if (!obj.name && (obj.given_name || obj.family_name)) {
        obj.name = obj.given_name + " " + obj.family_name;
    }

    if (user.user_metadata) {
        obj.birth_date = user.user_metadata.birth_date;
        obj.phone_number = user.user_metadata.phone_number;
        obj.address_line_1 = user.user_metadata.address_line_1;
        obj.address_line_2 = user.user_metadata.address_line_2;
        obj.postal_code = user.user_metadata.postal_code;
        obj.city = user.user_metadata.city;
        obj.country = user.user_metadata.country;
    }
    else {
        obj.birth_date = null;
        obj.phone_number = null;
        obj.address_line_1 = null;
        obj.address_line_2 = null;
        obj.postal_code = null;
        obj.city = null;
        obj.country = null;
    }

    if (user.app_metadata) {
        obj.roles = user.app_metadata.roles;
    }
    else {
        obj.roles = null;
    }

    obj.admin = userHasRole(user, "admin");

    if (includePayments) {
        obj.payments = {
            membership: getUserAppMetaDataFee(user, "membfee_payed_until", "membfee_method", "membfee_amount", "year"),
            housecard: getUserAppMetaDataFee(user, "housecard_payed_until", "housecard_method", "housecard_amount", "month")
        };
    }

    return obj;
}

/**
 * Get a property object containing payment information (based on properties set in a user's app_metadata object).
 * The result object has this structure:
 * {
 *  payed: boolean,
 *  payedUntil: Date,
 *  method: string ("manual" or "stripe"),
 *  methodName: string (e.g "Stripe"),
 *  amount: number,
 *  amountPeriod: string ("month" or "year"),
 *  error: boolean,
 *  errorMessage: string
 * }
 * @param {Auth0User} user
 * @param {string} payedUntilProperty
 * @param {string} methodProperty
 * @param {string} amountProperty
 * @param {string} amountPeriodProperty
 */
const getUserAppMetaDataFee = (user, payedUntilProperty, methodProperty, amountProperty, amountPeriod) => {

    var hasPayed = false;
    var payedUntilDate = null;
    var method = "";
    var methodName = "(none)";
    var amount = null;
    var isError = false;
    var errorMessage = null;

    if (user.app_metadata) {
        var payedUntilString = user.app_metadata[payedUntilProperty];

        if (payedUntilString) {
            var payedUntilDate = new Date(payedUntilString);

            if (payedUntilDate && !isNaN(payedUntilDate.getTime())) {

                var now = new Date();
                var today = new Date(now.getUTCFullYear(), now.getMonth(), now.getDate()); // Get current date, without time

                hasPayed = payedUntilDate >= today;

                method = user.app_metadata[methodProperty];

                if (method) {
                    switch (method) {
                        case "manual":
                            methodName = "Manual";
                            break;

                        case "stripe":
                            methodName = "Stripe";
                            break;

                        default:
                            methodName = "(unknown: " + method + ")";
                            break;
                    }

                }
                else {
                    methodName = "(none)";
                }

            }
            else {
                hasPayed = false;
                isError = true;
                errorMessage = 'The stored date for "payed until" has an invalid format';
            }
        }

        var amountString = user.app_metadata[amountProperty];

        if (amountString) {
            amount = parseInt(amountString);
            if (isNaN(amount)) {
                amount = null;
            }
        }
    }

    return {
        payed: hasPayed,
        payedUntil: payedUntilDate,
        method: method,
        methodName: methodName,
        amount: amount,
        amountPeriod: amountPeriod,
        error: isError,
        errorMessage: errorMessage
    }
}


/*
 * MIDDLEWARE HANDLERS
 */

// Authorization middleware. When used, the
// Access Token must exist and be verified against
// the Auth0 JSON Web Key Set.
// Note that the access token is not invalidated when the user logs out, it is self-contained
const checkJwt = jwt({
    // Dynamically provide a signing key
    // based on the kid in the header and
    // the signing keys provided by the JWKS endpoint.
    secret: jwksRsa.expressJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`
    }),

    // Validate the audience and the issuer.
    // !!! "audience" should be "https://app.eldsal.se/api/v1" to access our custom API, but that doesn't work right now
    // audience: 'https://app.eldsal.se/api/v1',
    audience: process.env.AUTH0_MGT_AUDIENCE,
    issuer: `https://${process.env.AUTH0_DOMAIN}/`,
    algorithms: ['RS256']
});

// Middleware to check that the submitted parameter "userId" is the the same as the user id in the authentication token.
// checkJwt must be called before checkLoggedInUser
const checkLoggedInUser = (req, res, next) => {
    if (req.params.userId != req.user.sub) {
        returnError(res, "No logged in user", 401);
    }
    else {
        next();
    }
}

// Middleware to check if a user has the "admin" role
const checkUserIsAdmin = async (req, res, next) => {

    const params = { id: req.user.sub };

    getManagementClient()
        .getUser(params)
        .then(function (user) {

            if (!userHasRole(user, "admin")) {
                returnError(res, "Admin role required", 403);
            }
            else {
                next();
            }

        })
        .catch(function (err) {
            returnError('Error getting user: ' + err);
        });
}


const checkScopes = jwtAuthz(['read:current_user']);


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

/*
router.get('/test', checkJwt, checkUserIsAdmin, async function (req, res) {

    console.log('test');
    console.log(req.user);

    const userId = req.user.sub;

    const params = { id: userId };

    getManagementClient()
        .getUser(params)
        .then(function (user) {
            res.json(user);
        })
        .catch(function (err) {
            // Handle error.
            console.error(err);
            returnError(res, err);
        });
});
*/

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

    if (userId != req.user.sub)
        return returnError(res, "You can only update your own user");

    const { given_name, family_name, birth_date, phone_number, address_line_1, address_line_2, postal_code, city, country } = req.body;

    if (!given_name)
        return returnError(res, "First name is required");

    if (!family_name)
        return returnError(res, "Surname is required");

    if (!birth_date)
        return returnError(res, "Birth date is required");

    if (!phone_number)
        return returnError(res, "Phone number is required");

    if (!address_line_1)
        return returnError(res, "Address is required");

    if (!postal_code)
        return returnError(res, "Postal code is required");

    if (!city)
        return returnError(res, "City is required");

    if (!country)
        return returnError(res, "Country is required");

    const params = { id: userId };

    const userArgument = {
        name: given_name + " " + family_name,
        given_name: given_name,
        family_name: family_name,
        user_metadata: {
            birth_date: birth_date,
            phone_number: phone_number,
            address_line_1: address_line_1,
            address_line_2: address_line_2,
            postal_code: postal_code,
            city: city,
            country: country
        }
    }

    getManagementClient()
        .updateUser(params, userArgument)
        .then(function (user) {
            res.json();
        })
        .catch(function (err) {
            // Handle error.
            console.error(err);
            returnError(res, err);
        });

});

/* Get users
 **/
router.get('/getUsers', checkJwt, checkUserIsAdmin, async function (req, res) {

    console.log('getUsers');

    getManagementClient()
        .getUsers()
        .then(function (users) {
            // Filter out only users from the connection specified in the env file
            res.json(users.filter(user => isUserInCurrentConnection(user)).map(user=>getUserClientObject(user)).sort((a, b) => stringCompare(a.name, b.name)));
        })
        .catch(function (err) {
            // Handle error.
            console.error(err);
            returnError(res, err);
        });

});

/* Export users as CSV file
 **/
router.get('/exportUsers', checkJwt, checkUserIsAdmin, async function (req, res) {

    console.log('exportUsers');

    const formatDate = (date) =>
    {
        if (date) {
            return new Intl.DateTimeFormat('sv-SE').format(date);
        }
        else {
            return null;
        }
    }

    const formatInt = (stringValue) => {
        if (stringValue === null || stringValue === "")
            return null;

        var intValue = parseInt(stringValue);

        if (isNaN(intValue))
            return null;


        return intValue;
    }

    getManagementClient()
        .getUsers()
        .then(function (users) {
            // Filter out only users from the connection specified in the env file

            const fields = [
                {
                    label: 'First name',
                    value: 'given_name'
                },
                {
                    label: 'Surname',
                    value: 'family_name'
                },
                {
                    label: 'Email',
                    value: 'email'
                },
                {
                    label: 'Birth date',
                    value: 'birth_date'
                },
                {
                    label: 'Phone number',
                    value: 'phone_number'
                },
                {
                    label: 'Address',
                    value: 'address_line_1'
                },
                {
                    label: 'Address (line 2)',
                    value: 'address_line_2'
                },
                {
                    label: 'Postal code',
                    value: 'postal_code'
                },
                {
                    label: 'City',
                    value: 'city'
                },
                {
                    label: 'Country',
                    value: 'country'
                },
                {
                    label: 'Membership payed',
                    value: (row) => row.payments.membership.payed ? "Yes" : "No"
                },
                {
                    label: 'Membership payed until',
                    value: (row) => formatDate(row.payments.membership.payedUntil)
                },
                {
                    label: 'Membership payed amount (SEK/year)',
                    value: (row) => formatInt(row.payments.membership.amount)
                },
                {
                    label: 'Membership payment method',
                    value: 'payments.membership.methodName'
                },
                {
                    label: 'House card payed',
                    value: (row) => row.payments.housecard.payed ? "Yes" : "No"
                },
                {
                    label: 'House card payed until',
                    value: (row) => formatDate(row.payments.housecard.payedUntil)
                },
                {
                    label: 'House card payed amount (SEK/month)',
                    value: (row) => formatInt(row.payments.housecard.amount)
                },
                {
                    label: 'House card payment method',
                    value: 'payments.housecard.methodName'
                }
            ];

            const usersJson = users.filter(user => isUserInCurrentConnection(user)).map(user => getUserClientObject(user)).sort((a, b) => stringCompare(a.name, b.name));

            const json2csv = new Parser({ fields, withBOM: true });
            const csv = json2csv.parse(usersJson);

            // The withBOM option in Parser should add BOM character to CSV to signal UTF-8, but it doesn't.
            // The only way I've got it to work is to use withBOM:true AND manually adding the BOM character to the response. /DO
            const bom = "\ufeff";

            res.status(200).contentType("text/csv").attachment("EldsalMemberList.csv").send(bom + csv);
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
router.get('/getChangeUserPasswordUrl/:userId', checkJwt, checkScopes, async function (req, res) {

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

/* Update membership fee payment for user
 * Argument object:
 *  payed: boolean
 *  method: string ("manual" | "stripe")
 *  payedUntil: date (YYYY-MM-DD)
 *  amount: number (yearly amount)
 **/
router.patch('/updateUserMembership/:userId', checkJwt, checkUserIsAdmin, async function (req, res) {

    console.log('updateUserMembership');

    const userId = req.params.userId;
    console.log(userId);

    const { payed, method, payedUntil, amount } = req.body;

    var argPayedUntil, argMethod, argAmount;

    switch (payed) {
        case true:

            // Method
            if (!method)
                return badRequest(res, "Payment method is required");

            switch (method) {
                case "stripe":
                case "manual":
                    argMethod = method;
                    break;

                default:
                    return badRequest(res, `Invalid payment method ${method}`);
            }

            // Payed until
            if (!payedUntil)
                return badRequest(res, "Payed until date is required");

            if (!/^\d{4}-\d{2}-\d{2}$/.test(payedUntil))
                return badRequest(res, "Payed until date must be in format YYYY-MM-DD");

            var payedUntilDate = new Date(payedUntil);

            if(payedUntilDate <= new Date())
                return badRequest(res, "Payed until must be a future date");

            argPayedUntil = payedUntil;

            // Amount
            argAmount = parseInt(amount);
            if (isNaN(argAmount) || argAmount < 0)
                return badRequest(res, "Invalid amount");

            break;

        case false:
            argPayedUntil = null;
            argMethod = null;
            argAmount = null;
            break;

        default:
            return badRequest(res, "Invalid value for \"payed\"");
    }


    const userArgument = {
        app_metadata: {
            membfee_payed_until: argPayedUntil,
            membfee_method: argMethod,
            membfee_amount: argAmount
        }
    }

    const params = { id: userId };

    getManagementClient()
        .updateUser(params, userArgument)
        .then(function (user) {
            res.json(getUserClientObject(user));
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
router.patch('/updateUserHousecard/:userId', checkJwt, checkUserIsAdmin, async function (req, res) {

    console.log('updateUserHousecard');

    const userId = req.params.userId;
    console.log(userId);

    const { payed, method, payedUntil, amount } = req.body;

    var argPayedUntil, argMethod, argAmount

    switch (payed) {
        case true:

            // Method
            if (!method)
                return badRequest(res, "Payment method is required");

            switch (method) {
                case "stripe":
                case "manual":
                    argMethod = method;
                    break;

                default:
                    return badRequest(res, `Invalid payment method ${method}`);
            }

            // Payed until
            if (!payedUntil)
                return badRequest(res, "Payed until date is required");

            if (!/^\d{4}-\d{2}-\d{2}$/.test(payedUntil))
                return badRequest(res, "Payed until date must be in format YYYY-MM-DD");

            var payedUntilDate = new Date(payedUntil);

            if (payedUntilDate <= new Date())
                return badRequest(res, "Payed until must be a future date");

            argPayedUntil = payedUntil;

            // Amount
            argAmount = parseInt(amount);
            if(isNaN(argAmount) || argAmount < 0)
                return badRequest(res, "Invalid amount");

            break;

        case false:
            argPayedUntil = null;
            argMethod = null;
            argAmount = null;
            break;

        default:
            return badRequest(res, "Invalid value for \"payed\"");
    }


    const userArgument = {
        app_metadata: {
            housecard_payed_until: argPayedUntil,
            housecard_method: argMethod,
            housecard_amount: argAmount
        }
    }

    const params = { id: userId };

    getManagementClient()
        .updateUser(params, userArgument)
        .then(function (user) {
            res.json(getUserClientObject(user));
        })
        .catch(function (err) {
            // Handle error.
            console.error(err);
            internalServerError(res, err);
        });
});


router.get('/subscriptions',  checkJwt, async (req, res) => {

    const user = await getManagementClient().getUser({id: req.user.sub});

    const membfeeResponse = await getStripeClient("membfee").subscriptions.list({customer: user.app_metadata.stripe_customer_membfee});
    const housecardResponse = await getStripeClient("housecard").subscriptions.list({customer: user.app_metadata.stripe_customer_housecard});

    res.json({membfeeSubs: membfeeResponse.data, housecardSubs: housecardResponse.data});
});

router.get('/prices',  checkJwt, async (req, res) => {

    const user = await getManagementClient().getUser({id: req.user.sub});
    const flavour = req.query.flavour;
    const products = (await getStripeClient(flavour).products.list({limit : 100})).data;
    const prices = (await getStripeClient(flavour).prices.list({limit : 100})).data;

    res.json({prices, products});

});

router.get('/check-stripe-session',  checkJwt, async (req, res) => {

    const flavour = req.query.flavour;
    const user = await getManagementClient().getUser({id: req.user.sub});

    const session = await getStripeClient(flavour).checkout.sessions.retrieve(user.app_metadata.stripe_session_id);

    await getManagementClient().updateUser({id: req.user.sub}, {app_metadata: {["stripe_customer_" + flavour]: session.customer,
                                                                                            ["stripe_status_" + flavour]: session.payment_status,
                                                                                          }});

    res.json({});
});

const getStripeClient = (flavour) => {
    if (flavour === "membfee") {
        return stripe_membfee;
    } else if (flavour === "housecard") {
        return stripe_housecard;
    }
};

router.post('/create-checkout-session',  checkJwt,  async (req, res) => {

    const flavour = req.query.flavour;
    const price = req.query.price;

    console.log(price);

    const user = await getManagementClient().getUser({id: req.user.sub});

    let sessionObj = {
        payment_method_types: ['card'],
        client_reference_id: req.user.sub,
        line_items: [
            {
                price: price,
                quantity: 1,
            },
        ],
        mode: 'subscription',
        success_url: 'https://local.eldsal.se/afterpurchase?flavour=' + flavour,
        cancel_url: 'https://local.eldsal.se/subscription',
    };


    if (user.app_metadata["stripe_customer_" + flavour]) {
        sessionObj = { ...sessionObj, customer : user.app_metadata["stripe_customer_" + flavour]};
    } else {
        sessionObj = { ...sessionObj, customer_email : user.email};
    }

    console.log(sessionObj);

    const session = await getStripeClient(flavour).checkout.sessions.create(sessionObj);

    await getManagementClient().updateUser({id: req.user.sub}, {app_metadata: {stripe_session_id: session.id}});

    res.json({ id: session.id });
});

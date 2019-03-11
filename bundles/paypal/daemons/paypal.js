
// require daemon
const config = require('config');
const Daemon = require('daemon');
const paypal = require('paypal-rest-sdk');

/**
 * Stripe Daemon
 *
 * @extends Daemon
 */
class PaypalDaemon extends Daemon {
  /**
   * construct paypal daemon
   */
  constructor() {
    // run super
    super(...arguments);

    // bind variables
    paypal.configure(config.get('paypal'));

    // add endpoint
    this.eden.endpoint('subscription.paypal.cancel', async (subscription) => {
      // cancel subscription
      subscription.set('cancel', await new Promise((resolve, reject) => paypal.billingAgreement.cancel(subscription.get('paypal.id'), {
        note : 'Cancelled as per request',
      }, (err, res) => {
        // check error
        if (err) return reject(err);

        // resolve
        resolve(res);
      })));

      // set state
      subscription.set('state', 'cancelled');

      // save subscription
      await subscription.save();
    });

    // update agreement
    this.eden.endpoint('subscription.paypal.update', async (subscription) => {
      // cancel subscription
      const agreement = await new Promise((resolve, reject) => paypal.billingAgreement.get(subscription.get('paypal.id'), (err, res) => {
        // check error
        if (err) return reject(err);

        // resolve
        resolve(res);
      }));

      // check state
      if (agreement.state === 'Cancelled') {
        // set state
        subscription.set('cancel', agreement);

        // set state
        subscription.set('state', 'cancelled');

        // save subscription
        await subscription.save();
      }
    });
  }
}

/**
 * export paypal daemon
 *
 * @type {*}
 */
exports = module.exports = PaypalDaemon;

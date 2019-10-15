/* eslint-disable consistent-return */

// require dependencies
const money      = require('money-math');
const config     = require('config');
const paypal     = require('paypal-rest-sdk');
const moment     = require('moment');
const Controller = require('controller');

// get models
const Payment = model('payment');
const Product = model('product');

/**
 * build example dameon class
 *
 * @mount /paypal
 */
class PaypalController extends Controller {
  /**
   * construct example daemon class
   */
  constructor() {
    // run super eden
    super();

    // bind variables
    paypal.configure(config.get('paypal'));

    // bind methods
    this.build = this.build.bind(this);

    // bind private method
    this._pay = this._pay.bind(this);
    this._method = this._method.bind(this);

    // build paypal daemon
    this.build();
  }

  /**
   * build paypal daemon
   */
  build() {
    // hook payment
    this.eden.pre('payment.init', this._method);

    // hook payment pay
    this.eden.post('payment.pay', this._pay);
  }

  /**
   * index action
   *
   * @param req
   * @param res
   *
   * @route    {get} /process
   * @route    {get} /process/:id
   */
  async processAction(req, res) {
    // get payment id from query
    const payerId = {
      payer_id : req.query.PayerID,
    };
    const { paymentId } = req.query;

    // get payment
    const payment = req.params.id ? await Payment.findById(req.params.id) : await Payment.where({
      'paypal.id'   : paymentId,
      'method.type' : 'paypal',
    }).sort('created_at', 1).findOne();

    // check payment
    if (!payment) return res.redirect('/checkout');

    // get order
    const invoice = await payment.get('invoice');
    const orders  = await invoice.get('orders');

    // await payment create
    if (payment.get('paypal.plan')) {
      // execute payment
      paypal.billingAgreement.execute(req.query.token, async (error, agreement) => {
        // check error
        if (error) {
          // set error
          payment.set('error', error.toString());

          // redirect to order page
          return res.redirect(`/order/${orders[0].get('_id').toString()}`);
        }

        // remove redirect
        orders.forEach(order => order.set('redirect', null));

        // set payment info
        payment.set('complete', new Date());
        payment.set('data.payment', agreement);

        // save payment
        await payment.save(await orders[0].get('user'));

        // save order
        await Promise.all(orders.map(order => order.save()));

        // get subscriptions
        const subscriptions = [].concat(...(await Promise.all(orders.map(order => order.get('subscriptions'))))).filter(s => s);

        // loop subscriptions
        await Promise.all(subscriptions.map(async (subscription) => {
          // set paypal
          subscription.set('paypal', agreement);

          // save subscription
          await subscription.save(await orders[0].get('user'));
        }));

        // redirect to order page
        res.redirect(`/order/${orders[0].get('_id').toString()}`);
      });
    } else {
      // execute payment
      paypal.payment.execute(paymentId, payerId, async (error, paypalPayment) => {
        // check error
        if (error) {
          // set error
          payment.set('error', error.toString());

          // redirect to order page
          res.redirect(`/order/${orders[0].get('_id').toString()}`);
        }

        // check state
        if (paypalPayment.state === 'approved') {
          // remove redirect
          orders.forEach(order => order.set('redirect', null));

          // set payment info
          payment.set('complete', new Date());
          payment.set('data.payment', paypalPayment);
        } else {
          // set payment details
          payment.set('complete', false);
          payment.set('error', {
            id   : 'paypal.fail',
            text : 'Payment not successful',
          });
        }

        // save payment
        await payment.save(await orders[0].get('user'));

        // save order
        await Promise.all(orders.map(order => order.save()));

        // redirect to order page
        res.redirect(`/order/${orders[0].get('_id').toString()}`);
      });
    }
  }

  /**
   * index action
   *
   * @param req
   * @param res
   *
   * @route    {get} /cancel
   */
  async cancelAction(req, res) {
    // redirect to Checkout
    res.redirect('/checkout');
  }

  /**
   * pay invoice
   *
   * @param  {product} Payment
   *
   * @return {Promise}
   */
  async _pay(payment) {
    // check method
    if (payment.get('error') || payment.get('method.type') !== 'paypal') return null;

    // load user
    const invoice = await payment.get('invoice');
    const orders  = await invoice.get('orders');

    // check type
    const subscriptions = [].concat(...(await Promise.all(orders.map(order => order.get('subscriptions'))))).filter(s => s);

    // check if subscription
    if (subscriptions && subscriptions.length) {
      // return normal subscription
      return await this._subscription(payment, subscriptions);
    }
    // return normal payment
    return await this._normal(payment);
  }

  /**
   * creates normal payment
   *
   * @param  {Payment}  payment
   *
   * @return {Promise}
   */
  async _normal(payment) {
    // load user
    const invoice = await payment.get('invoice');

    // map lines
    const lines = invoice.get('lines');

    // let items
    const items = lines.map((line) => {
      // return object
      return {
        sku      : line.sku,
        name     : line.title,
        price    : money.floatToAmount(parseFloat(line.price)),
        currency : payment.get('currency') || config.get('shop.currency') || 'USD',
        quantity : parseInt(line.qty, 10),
      };
    });

    // get real total
    let realDisc = '0.00';
    const realTotal = items.reduce((accum, line) => {
      // return accum
      return money.add(accum, money.floatToAmount(parseFloat(line.price) * (line.quantity || 1)));
    }, '0.00');

    // check discount
    if (money.isNegative(money.subtract(money.floatToAmount(payment.get('amount')), realTotal))) {
      // set discount
      realDisc = money.subtract(money.floatToAmount(payment.get('amount')), realTotal);

      // push discount
      items.push({
        sku      : 'discount',
        name     : 'Discount',
        price    : realDisc,
        currency : payment.get('currency') || config.get('shop.currency') || 'USD',
        quantity : 1,
      });
    }

    // get total
    const payReq = JSON.stringify({
      payer  : {
        payment_method : 'paypal',
      },
      intent        : 'sale',
      redirect_urls : {
        return_url : `https://${config.get('domain')}/paypal/process`,
        cancel_url : `https://${config.get('domain')}/paypal/cancel`,
      },
      transactions : [{
        item_list : {
          items,
        },
        amount : {
          total    : money.add(realTotal, realDisc),
          currency : payment.get('currency') || config.get('shop.currency') || 'USD',
        },
        description : `Payment for invoice #${invoice.get('_id').toString()}.`,
      }],
    });

    // create paypal redirect url
    return await new Promise((resolve) => {
      // create payment
      paypal.payment.create(payReq, (e, paypalPayment) => {
        // get links
        const links = {};

        // check error
        if (e) {
          // set error
          return resolve(payment.set('error', {
            id   : 'paypal.error',
            text : e.toString(),
          }));
        }

        // Capture HATEOAS links
        paypalPayment.links.forEach((linkObj) => {
          // set link to object
          links[linkObj.rel] = {
            href   : linkObj.href,
            method : linkObj.method,
          };
        });

        // If redirect url present, redirect user
        if (links.approval_url) {
          // set date
          payment.set('data', {
            redirect : links.approval_url.href,
          });
          payment.set('paypal', {
            id : paypalPayment.id,
          });

          // set redirect
          return resolve(payment.set('redirect', payment.get('data.redirect')));
        }

        // resolve
        return resolve(payment.set('error', {
          id   : 'paypal.nourl',
          text : 'no redirect URI present',
        }));
      });
    });
  }

  /**
   * create payment subscription
   *
   * @param  {Payment}      payment
   * @param  {Subscription} subscription
   *
   * @return {Promise}
   */
  async _subscription(payment) {
    // load user
    const invoice = await payment.get('invoice');

    // map lines
    const lines = invoice.get('lines');

    // let items
    const items = await Promise.all(lines.map(async (line) => {
      // get product
      const product = await Product.findById(line.product);

      // return object
      return {
        sku      : product.get('sku') + (Object.values(line.opts || {})).join('_'),
        name     : product.get('title.en-us'),
        type     : product.get('type'),
        price    : money.floatToAmount(parseFloat(line.price)),
        amount   : money.floatToAmount(parseFloat(line.total - (line.discount || 0))),
        period   : (line.opts || {}).period,
        product  : product.get('_id').toString(),
        discount : line.discount || 0,
        currency : payment.get('currency') || config.get('shop.currency') || 'USD',
        quantity : parseInt(line.qty || 1, 10),
      };
    }));

    // get all subscription items
    const subscriptionItems = items.filter((item) => {
      // check if subscription
      return item.type === 'subscription';
    });

    // get real total
    const normalTotal  = money.floatToAmount(payment.get('amount'));
    const initialTotal = subscriptionItems.reduce((accum, line) => {
      // return accum
      accum = money.add(accum, money.floatToAmount(parseFloat(line.price) * (line.quantity || 1)));

      // return value
      return money.subtract(accum, money.floatToAmount(line.discount));
    }, '0.00');

    // set periods
    const periods = {
      weekly : {
        frequency          : 'WEEK',
        frequency_interval : '1',
      },
      monthly : {
        frequency          : 'MONTH',
        frequency_interval : '1',
      },
      quarterly : {
        frequency          : 'MONTH',
        frequency_interval : '3',
      },
      biannually : {
        frequency          : 'MONTH',
        frequency_interval : '6',
      },
      annually : {
        frequency          : 'YEAR',
        frequency_interval : '1',
      },
    };

    // set trial definition
    let trialDefinition = null;

    // check trial
    if (invoice.get('trial')) {
      // get diff
      const diff = Math.ceil(moment(invoice.get('trial')).diff(moment(), `${periods[subscriptionItems[0].period].frequency}s`.toLowerCase(), true));

      // set trial definition
      trialDefinition = {
        name               : `Subscription #${invoice.get('_id').toString()} ${(new Date()).toISOString()} Trial`,
        type               : 'TRIAL',
        frequency          : periods[subscriptionItems[0].period].frequency,
        frequency_interval : periods[subscriptionItems[0].period].frequency_interval,
        amount             : {
          value    : '0.00',
          currency : config.get('shop.currency') || 'USD',
        },
        // eslint-disable-next-line max-len
        cycles : Math.ceil(diff / parseInt(periods[subscriptionItems[0].period].frequency_interval, 10)).toString(),
      };
    }

    // create subscription element
    const paymentDefinition = {
      name               : `Subscription #${invoice.get('_id').toString()} ${(new Date()).toISOString()}`,
      type               : 'REGULAR',
      frequency          : periods[subscriptionItems[0].period].frequency,
      frequency_interval : periods[subscriptionItems[0].period].frequency_interval,
      amount             : {
        value : subscriptionItems.reduce((total, item) => {
          // return money add
          return money.add(total, money.floatToAmount(item.amount));
        }, '0.00'),
        currency : config.get('shop.currency') || 'USD',
      },
      cycles : '0',
    };

    // get total
    const billingPlan = {
      name                 : `Subscription plan for #${payment.get('_id').toString()}`,
      type                 : 'INFINITE',
      description          : `Subscription plan for #${payment.get('_id').toString()}`,
      // eslint-disable-next-line max-len
      payment_definitions  : trialDefinition ? [paymentDefinition, trialDefinition] : [paymentDefinition],
      merchant_preferences : {
        setup_fee : {
          value    : money.subtract(normalTotal, initialTotal),
          currency : config.get('shop.currency') || 'USD',
        },
        return_url                 : `https://${config.get('domain')}/paypal/process/${payment.get('_id').toString()}`,
        cancel_url                 : `https://${config.get('domain')}/paypal/cancel`,
        auto_bill_amount           : 'YES',
        max_fail_attempts          : '1',
        initial_fail_amount_action : 'CONTINUE',
      },
    };

    // create billing plan
    const createdPlan = await new Promise((resolve, reject) => {
      // create plan
      paypal.billingPlan.create(JSON.stringify(billingPlan), (e, plan) => {
        // reject error
        if (e) return reject(e);

        // resolve plan
        resolve(plan);
      });
    });

    // Activate the plan by changing status to Active
    await new Promise((resolve, reject) => {
      // update created plan
      paypal.billingPlan.update(createdPlan.id, [
        {
          op    : 'replace',
          path  : '/',
          value : {
            state : 'ACTIVE',
          },
        },
      ], (e, res) => {
        // resolve
        if (e) return reject(e);

        // resolve
        return resolve(res);
      });
    });

    // create iso date
    const isoDate = new Date();
    isoDate.setHours(isoDate.getHours() + 1);

    // create actual agreement
    const billingAgreement = {
      name        : `Payment for invoice #${invoice.get('_id').toString()}.`,
      start_date  : isoDate,
      description : `Payment for invoice #${invoice.get('_id').toString()}.`,
      plan        : {
        id : createdPlan.id,
      },
      payer : {
        payment_method : 'paypal',
      },
    };

    // create paypal redirect url
    return await new Promise((resolve) => {
      // create payment
      paypal.billingAgreement.create(JSON.stringify(billingAgreement), (e, agreement) => {
        // get links
        const links = {};

        // check error
        if (e) {
          // set error
          return resolve(payment.set('error', {
            id   : 'paypal.error',
            text : e.toString(),
          }));
        }

        // Capture HATEOAS links
        agreement.links.forEach((linkObj) => {
          // set link to object
          links[linkObj.rel] = {
            href   : linkObj.href,
            method : linkObj.method,
          };
        });

        // If redirect url present, redirect user
        if (links.approval_url) {
          // set date
          payment.set('data', {
            redirect : links.approval_url.href,
          });
          payment.set('paypal', agreement);

          // set redirect
          return resolve(payment.set('redirect', payment.get('data.redirect')));
        }
        return resolve(payment.set('error', {
          id   : 'paypal.nourl',
          text : 'no redirect URI present',
        }));
      });
    });
  }

  /**
   * opts
   *
   * @param  {Object}  opts
   *
   * @return {Promise}
   */
  async _method(order, action) {
    // check action
    if (action.type !== 'payment') return;

    // return sanitised data
    action.data.methods.push({
      type     : 'paypal',
      data     : {},
      priority : 1,
    });
  }
}

/**
 * export Paypal Controller class
 *
 * @type {PaypalController}
 */
module.exports = PaypalController;
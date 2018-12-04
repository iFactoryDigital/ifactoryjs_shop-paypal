
// require dependencies
const money      = require('money-math');
const config     = require('config');
const paypal     = require('paypal-rest-sdk');
const Controller = require('controller');

// get models
const Payment = model('payment');
const Product = model('product');

// require helpers
const ProductHelper = helper('product');

/**
 * build example dameon class
 *
 * @mount /paypal
 */
class PaypalController extends Controller {
  /**
   * construct example daemon class
   */
  constructor () {
    // run super eden
    super();

    // bind variables
    paypal.configure(config.get('paypal'));

    // bind methods
    this.build = this.build.bind(this);

    // bind private method
    this._pay    = this._pay.bind(this);
    this._method = this._method.bind(this);

    // build paypal daemon
    this.build();
  }

  /**
   * build paypal daemon
   */
  build () {
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
  async processAction (req, res) {
    // get payment id from query
    let payerId = {
      'payer_id' : req.query.PayerID
    };
    let paymentId = req.query.paymentId;

    // get payment
    let payment = req.params.id ? await Payment.findById(req.params.id) : await Payment.findOne({
      'paypal.id'   : paymentId,
      'method.type' : 'paypal'
    });

    // check payment
    if (!payment) return res.redirect('/checkout');

    // get order
    let order         = await (await payment.get('invoice')).get('order');
    let subscriptions = await order.get('subscriptions');

    // await payment create
    if (subscriptions && subscriptions.length) {
      // execute payment
      paypal.billingAgreement.execute(req.query.token, async (error, agreement) => {
        // check error
        if (error) {
          // set error
          payment.set('error', error.toString());

          // redirect to order page
          res.redirect('/order/' + order.get('_id').toString());
        }

        // remove redirect
        order.set('redirect', null);

        // set payment info
        payment.set('complete',     true);
        payment.set('data.payment', payment);

        // save payment
        await payment.save();

        // save order
        await order.save();

        // loop subscriptions
        subscriptions.forEach((subscription) => {
          // set paypal
          subscription.set('paypal', agreement);
          subscription.save();
        });

        // redirect to order page
        res.redirect('/order/' + order.get('_id').toString());
      });
    } else {
      // execute payment
      paypal.payment.execute(paymentId, payerId, async (error, paypalPayment) => {
        // check error
        if (error) {
          // set error
          payment.set('error', error.toString());

          // redirect to order page
          res.redirect('/order/' + order.get('_id').toString());
        }

        // check state
        if (paypalPayment.state === 'approved') {
          // remove redirect
          order.set('redirect', null);

          // set payment info
          payment.set('complete',     true);
          payment.set('data.payment', paypalPayment);
        } else {
          // set payment details
          payment.set('complete', false);
          payment.set('error', {
            'id'   : 'paypal.fail',
            'text' : 'Payment not successful'
          });
        }

        // save payment
        await payment.save();

        // save order
        await order.save();

        // redirect to order page
        res.redirect('/order/' + order.get('_id').toString());
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
  async cancelAction (req, res) {
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
  async _pay (payment) {
    // check method
    if (payment.get('error') || payment.get('method.type') !== 'paypal') return;

    // load user
    let invoice = await payment.get('invoice');
    let order   = await invoice.get('order');

    // check type
    let subscriptions = await order.get('subscriptions');

    // check if subscription
    if (subscriptions && subscriptions.length) {
      // return normal subscription
      return await this._subscription(payment, subscriptions);
    } else {
      // return normal payment
      return await this._normal(payment);
    }
  }

  /**
   * creates normal payment
   *
   * @param  {Payment}  payment
   *
   * @return {Promise}
   */
  async _normal (payment) {
    // load user
    let invoice = await payment.get('invoice');
    let order   = await invoice.get('order');

    // let items
    let items = await Promise.all(invoice.get('lines').map(async (line) => {
      // get product
      let product = await Product.findById(line.product);

      // get price
      let price = await ProductHelper.price(product, line.opts || {});

      // return value
      let amount = parseFloat(price.amount) * parseInt(line.qty || 1);

      // hook
      await this.eden.hook('line.price', {
        'qty'  : line.qty,
        'user' : await order.get('user'),
        'opts' : line.opts,

        order,
        price,
        amount,
        product
      });

      // return object
      return {
        'sku'      : product.get('sku') + (Object.values(line.opts || {})).join('_'),
        'name'     : product.get('title.en-us'),
        'price'    : money.floatToAmount(parseFloat(price.amount)),
        'currency' : payment.get('currency') || 'USD',
        'quantity' : parseInt(line.qty)
      };
    }));

    // get real total
    let realDisc  = '0.00';
    let realTotal = items.reduce((accum, line) => {
      // return accum
      return money.add(accum, money.floatToAmount(parseFloat(line.price) * (line.quantity || 1)));
    }, '0.00');

    // check discount
    if (money.isNegative(money.subtract(money.floatToAmount(payment.get('amount')), realTotal))) {
     // set discount
      realDisc = money.subtract(money.floatToAmount(payment.get('amount')), realTotal);

      // push discount
      items.push({
        'sku'      : 'discount',
        'name'     : 'Discount',
        'price'    : realDisc,
        'currency' : payment.get('currency') || 'USD',
        'quantity' : 1
      });
    }

    // get total
    let payReq = JSON.stringify({
      'payer'  : {
        'payment_method' : 'paypal'
      },
      'intent' : 'sale',
      'redirect_urls' : {
        'return_url' : 'https://' + config.get('domain') + '/paypal/process',
        'cancel_url' : 'https://' + config.get('domain') + '/paypal/cancel'
      },
      'transactions' : [{
        'item_list' : {
          'items' : items
        },
        'amount' : {
          'total'    : money.add(realTotal, realDisc),
          'currency' : payment.get('currency') || 'USD'
        },
        'description' : 'Payment for invoice #' + invoice.get('_id').toString() + '.'
      }]
    });

    // create paypal redirect url
    return await new Promise((resolve, reject) => {
      // create payment
      paypal.payment.create(payReq, (e, paypalPayment) => {
        // get links
        let links = {};

        // check error
        if (e) {
          // set error
          return resolve(payment.set('error', {
            'id'   : 'paypal.error',
            'text' : e.toString()
          }));
        }

        // Capture HATEOAS links
        paypalPayment.links.forEach((linkObj) => {
          // set link to object
          links[linkObj.rel] = {
            'href'   : linkObj.href,
            'method' : linkObj.method
          };
        });

        // If redirect url present, redirect user
        if (links.hasOwnProperty('approval_url')) {
          // set date
          payment.set('data', {
            'redirect' : links['approval_url'].href
          });
          payment.set('paypal', {
            'id' : paypalPayment.id
          });

          // set redirect
          return resolve(payment.set('redirect', payment.get('data.redirect')));
        } else {
          return resolve(payment.set('error', {
            'id'   : 'paypal.nourl',
            'text' : 'no redirect URI present'
          }));
        }
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
  async _subscription (payment, subscriptions) {
    // load user
    let invoice = await payment.get('invoice');
    let order   = await invoice.get('order');

    // let items
    let items = await Promise.all(invoice.get('lines').map(async (line) => {
      // get product
      let product = await Product.findById(line.product);

      // get price
      let price = await ProductHelper.price(product, line.opts || {});

      // return value
      let amount = parseFloat(price.amount) * parseInt(line.qty || 1);

      // hook
      await this.eden.hook('line.price', {
        'qty'  : line.qty,
        'user' : await order.get('user'),
        'opts' : line.opts,

        order,
        price,
        amount,
        product
      });

      // return object
      return {
        'sku'      : product.get('sku') + (Object.values(line.opts || {})).join('_'),
        'name'     : product.get('title.en-us'),
        'type'     : product.get('type'),
        'price'    : money.floatToAmount(parseFloat(price.amount)),
        'amount'   : amount,
        'period'   : (line.opts || {}).period,
        'product'  : product.get('_id').toString(),
        'currency' : payment.get('currency') || 'USD',
        'quantity' : line.qty
      };
    }));

    // get all subscription items
    let subscriptionItems = items.filter((item) => {
      // check if subscription
      return item.type === 'subscription';
    });

    // get all normal items
    let normalItems = items.filter((item) => {
      // check if subscription
      return item.type !== 'subscription';
    });

    // get real total
    let normalDisc  = '0.00';
    let normalTotal = normalItems.reduce((accum, line) => {
      // return accum
      return money.add(accum, money.floatToAmount(parseFloat(line.price) * (line.quantity || 1)));
    }, '0.00');

    // set periods
    let periods = {
      'weekly' : {
        'frequency'          : 'WEEK',
        'frequency_interval' : '1'
      },
      'monthly' : {
        'frequency'          : 'MONTH',
        'frequency_interval' : '1'
      },
      'quarterly' : {
        'frequency'          : 'MONTH',
        'frequency_interval' : '3'
      },
      'biannually' : {
        'frequency'          : 'MONTH',
        'frequency_interval' : '6'
      },
      'annually' : {
        'frequency'          : 'YEAR',
        'frequency_interval' : '1'
      }
    };

    // create subscription element
    let paymentDefinition = {
      'name'               : 'Subscription #' + order.get('_id').toString() + ' ' + (new Date()).toISOString(),
      'type'               : 'REGULAR',
      'frequency'          : periods[subscriptionItems[0].period].frequency,
      'frequency_interval' : periods[subscriptionItems[0].period].frequency_interval,
      'amount' : {
        'value' : subscriptionItems.reduce((total, item) => {
          // return money add
          return money.add(total, money.floatToAmount(item.amount));
        }, '0.00'),
        'currency' : 'USD'
      },
      'cycles' : '0'
    };

    // get total
    let billingPlan = {
      'name'                 : 'Subscription plan for #' + payment.get('_id').toString(),
      'type'                 : 'INFINITE',
      'description'          : 'Subscription plan for #' + payment.get('_id').toString(),
      'payment_definitions'  : [paymentDefinition],
      'merchant_preferences' : {
        'setup_fee' : {
          'value' : money.add(normalTotal, subscriptionItems.reduce((total, item) => {
            // return money add
            return money.add(total, money.floatToAmount(item.amount));
          }, '0')),
          'currency' : 'USD'
        },
        'return_url'                 : 'https://' + config.get('domain') + '/paypal/process/' + payment.get('_id').toString(),
        'cancel_url'                 : 'https://' + config.get('domain') + '/paypal/cancel',
        'auto_bill_amount'           : 'YES',
        'max_fail_attempts'          : '1',
        'initial_fail_amount_action' : 'CONTINUE'
      }
    };

    // create billing plan
    let createdPlan = await new Promise((resolve, reject) => {
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
          'op'    : 'replace',
          'path'  : '/',
          'value' : {
            'state' : 'ACTIVE'
          }
        }
      ], (e, res) => {
        // resolve
        if (e) return reject(e);

        // resolve
        resolve(res);
      });
    });

    // create iso date
    let isoDate = new Date();
    isoDate.setSeconds(isoDate.getSeconds() + 5);
    isoDate.toISOString().slice(0, 19) + 'Z';

    // create actual agreement
    let billingAgreement = {
      'name'        : 'Payment for invoice #' + invoice.get('_id').toString() + '.',
      'start_date'  : isoDate,
      'description' : 'Payment for invoice #' + invoice.get('_id').toString() + '.',
      'plan' : {
        'id' : createdPlan.id
      },
      'payer' : {
        'payment_method' : 'paypal'
      }
    };

    // create paypal redirect url
    return await new Promise((resolve, reject) => {
      // create payment
      paypal.billingAgreement.create(JSON.stringify(billingAgreement), (e, billingAgreement) => {
        // get links
        let links = {};

        // check error
        if (e) {
          // set error
          return resolve(payment.set('error', {
            'id'   : 'paypal.error',
            'text' : e.toString()
          }));
        }

        // Capture HATEOAS links
        billingAgreement.links.forEach((linkObj) => {
          // set link to object
          links[linkObj.rel] = {
            'href'   : linkObj.href,
            'method' : linkObj.method
          };
        });

        // If redirect url present, redirect user
        if (links.hasOwnProperty('approval_url')) {
          // set date
          payment.set('data', {
            'redirect' : links['approval_url'].href
          });
          payment.set('paypal', billingAgreement);

          // set redirect
          return resolve(payment.set('redirect', payment.get('data.redirect')));
        } else {
          return resolve(payment.set('error', {
            'id'   : 'paypal.nourl',
            'text' : 'no redirect URI present'
          }));
        }
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
  async _method (order, action) {
    // check action
    if (action.type !== 'payment') return;

    // return sanitised data
    action.data.methods.push({
      'type'     : 'paypal',
      'data'     : {},
      'priority' : 1
    });
  }
}

/**
 * export Paypal Controller class
 *
 * @type {PaypalController}
 */
exports = module.exports = PaypalController;

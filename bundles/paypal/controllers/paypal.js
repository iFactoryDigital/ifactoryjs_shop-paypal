
// require dependencies
const money      = require('money-math');
const config     = require('config');
const paypal     = require('paypal-rest-sdk');
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
    this.eden.pre('payment.pay', this._pay);
  }

  /**
   * index action
   *
   * @param req
   * @param res
   *
   * @route    {get} /process
   */
  async processAction (req, res) {
    // get payment id from query
    let payerId = {
      'payer_id' : req.query.PayerID
    };
    let paymentId = req.query.paymentId;

    // get payment
    let payment = await Payment.findOne({
      'paypal.id'   : paymentId,
      'method.type' : 'paypal'
    });

    // check payment
    if (!payment) return res.redirect('/checkout');

    // get order
    let order = await (await payment.get('invoice')).get('order');

    // await payment create
    paypal.payment.execute(paymentId, payerId, async (error, payment) => {
      // check error
      if (error) {
        // set error
        payment.set('error', error.toString());

        // redirect to order page
        res.redirect('/order/' + order.get('_id').toString());
      }

      // check state
      if (payment.state === 'approved') {
        // remove redirect
        order.set('redirect', null);

        // set payment info
        payment.set('complete',     true);
        payment.set('data.payment', payment);
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
    let order   = await payment.get('order');

    // let items
    let items = await Promise.all(invoice.get('lines').map(async (line) => {
      // priced
      let item = {
        'qty'     : line.qty,
        'opts'    : line.opts || {},
        'user'    : await order.get('user'),
        'product' : await product.findById(line.product)
      };

      // return price
      await this.eden.hook('product.order', item);

      // let opts
      let opts = {
        'qty'   : parseInt(line.qty),
        'item'  : item,
        'base'  : (parseFloat(item.price) || 0),
        'price' : (parseFloat(item.price) || 0) * parseInt(line.qty),
        'order' : order
      };

      // price item
      await this.eden.hook('line.price', opts);

      // return object
      return {
        'sku'      : item.product.get('sku').replace('ALI-', '') + (Object.values(line.opts || [])).join('_'),
        'name'     : item.product.get('title.en-us'),
        'price'    : money.floatToAmount(opts.base),
        'currency' : payment.get('currency') || 'USD',
        'quantity' : opts.qty,
      };
    }));

    // get real total
    let realDisc  = '0';
    let realTotal = items.reduce((accum, line) => {
      // return accum
      return money.add(accum, money.floatToAmount(parseFloat(line.price) * (line.quantity || 1)));
    }, '0');

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
      paypal.payment.create(payReq, (e, payment) => {
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
        payment.links.forEach((linkObj) => {
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
            'id' : payment.id
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

<paypal-method>
  <a href="#!" onclick={ onMethod }>
    <div class="row">
      <div class="col-8 d-flex align-items-center">
        <div class="w-100">
          <div class="custom-control custom-radio">
            <input name="payment-method-{ getUUID() }" value="paypal" type="radio" class="custom-control-input" checked={ opts.val.type === opts.method.type }>
            <label class="custom-control-label">{ this.t('paypal.method') }</label>
          </div>
        </div>
      </div>
      <div class="col-4 text-right">
        <img src="/public/assets/images/vendor/paypal.svg" class="paypal-logo" />
      </div>
    </div>
  </a>

  <script>
    // do mixins
    this.mixin('i18n');

    /**
     * on method function
     *
     * @param  {Event} e
     */
    onMethod (e) {
      // prevent default
      e.preventDefault();

      // on ready
      opts.onReady(opts.method);
    }

    /**
     * returns uuid
     *
     * @return {String}
     */
    getUUID () {
      // require uuid
      let uuid = require('uuid');

      // return uuid
      return uuid();
    }

  </script>
</paypal-method>

<paypal-payment>
  <a href="#!">
    <img src="/public/assets/images/vendor/paypal.svg" class="float-right paypal-logo" />
    <i class="fa fa-times text-danger mr-3" if={ !opts.payment.complete } />
    <i class="fa fa-check text-success mr-3" if={ opts.payment.complete } />
    { this.t ('paypal.order.' + (opts.payment.complete ? 'paid' : 'pending')) }
  </a>

  <script>
    // do mixins
    this.mixin('i18n');

  </script>
</paypal-payment>

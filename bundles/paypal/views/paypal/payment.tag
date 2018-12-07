<paypal-payment>
  <a href="#!">
    <img src="/public/assets/images/vendor/paypal.svg" class="float-right paypal-logo" />
    <i class="fa fa-times text-danger mr-3" if={ !opts.order.invoice.paid } />
    <i class="fa fa-check text-success mr-3" if={ opts.order.invoice.paid } />
    { this.t ('paypal.order.' + (opts.order.invoice.paid ? 'paid' : 'pending')) }
  </a>
  <div class="card-body" if={ !opts.order.invoice.paid }>
    <a href={ opts.order.redirect } class="btn btn-success">
      { this.t('paypal.order.redirect') }
    </a>
  </div>

  <script>
    // do mixins
    this.mixin('i18n');

  </script>
</paypal-payment>

// functions/stripe.js - Stripe integration
import { onCall, onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";
import Stripe from "stripe";

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

const db = getFirestore();

// Price IDs from your Stripe dashboard
const PRICE_IDS = {
  essential_monthly: 'price_1234567890abcdef',
  essential_annual: 'price_2345678901bcdefg',
  professional_monthly: 'price_3456789012cdefgh',
  professional_annual: 'price_4567890123defghi',
  powerUser_monthly: 'price_5678901234efghij',
  powerUser_annual: 'price_6789012345fghijk',
  clinicStarter_monthly: 'price_7890123456ghijkl',
  clinicPro_monthly: 'price_8901234567hijklm',
  enterprise_monthly: 'price_9012345678ijklmn'
};

// Create checkout session
export const createCheckoutSession = onCall(
  { 
    region: "us-east4",
    secrets: [STRIPE_SECRET_KEY]
  },
  async (request) => {
    const stripe = new Stripe(STRIPE_SECRET_KEY.value(), {
      apiVersion: '2023-10-16'
    });
    
    const { priceId, tier, interval, successUrl, cancelUrl } = request.data;
    const uid = request.auth?.uid;
    
    if (!uid) {
      throw new Error('Not authenticated');
    }
    
    try {
      // Get or create Stripe customer
      const userDoc = await db.collection('users').doc(uid).get();
      let customerId = userDoc.data()?.stripeCustomerId;
      
      if (!customerId) {
        const customer = await stripe.customers.create({
          metadata: { firebaseUID: uid },
          email: request.auth.token.email
        });
        customerId = customer.id;
        
        await db.collection('users').doc(uid).update({
          stripeCustomerId: customerId
        });
      }
      
      // Create checkout session
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{
          price: priceId,
          quantity: 1
        }],
        mode: 'subscription',
        success_url: successUrl || 'https://app.patientlead.plus/success',
        cancel_url: cancelUrl || 'https://app.patientlead.plus/subscribe',
        subscription_data: {
          trial_period_days: tier === 'essential' ? 7 : 14,
          metadata: {
            firebaseUID: uid,
            tier: tier,
            interval: interval
          }
        },
        metadata: {
          firebaseUID: uid,
          tier: tier
        },
        allow_promotion_codes: true,
        billing_address_collection: 'required'
      });
      
      return { 
        ok: true, 
        sessionId: session.id,
        url: session.url 
      };
      
    } catch (error) {
      console.error('Checkout session error:', error);
      throw new Error('Failed to create checkout session');
    }
  }
);

// Create customer portal session  
export const createPortalSession = onCall(
  {
    region: "us-east4", 
    secrets: [STRIPE_SECRET_KEY]
  },
  async (request) => {
    const stripe = new Stripe(STRIPE_SECRET_KEY.value(), {
      apiVersion: '2023-10-16'
    });
    
    const uid = request.auth?.uid;
    if (!uid) {
      throw new Error('Not authenticated');
    }
    
    try {
      const userDoc = await db.collection('users').doc(uid).get();
      const customerId = userDoc.data()?.stripeCustomerId;
      
      if (!customerId) {
        throw new Error('No subscription found');
      }
      
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: request.data.returnUrl || 'https://app.patientlead.plus/account'
      });
      
      return { 
        ok: true,
        url: session.url 
      };
      
    } catch (error) {
      console.error('Portal session error:', error);
      throw new Error('Failed to create portal session');
    }
  }
);

// Webhook handler for subscription events
export const stripeWebhook = onRequest(
  {
    region: "us-east4",
    secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET]
  },
  async (req, res) => {
    const stripe = new Stripe(STRIPE_SECRET_KEY.value(), {
      apiVersion: '2023-10-16'
    });
    
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }
    
    // Handle events
    try {
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          await handleSubscriptionUpdate(event.data.object);
          break;
          
        case 'customer.subscription.deleted':
          await handleSubscriptionCancellation(event.data.object);
          break;
          
        case 'invoice.payment_succeeded':
          await handlePaymentSuccess(event.data.object);
          break;
          
        case 'invoice.payment_failed':
          await handlePaymentFailure(event.data.object);
          break;
          
        default:
          console.log(`Unhandled event type ${event.type}`);
      }
      
      res.json({ received: true });
      
    } catch (error) {
      console.error('Webhook processing error:', error);
      res.status(500).send('Webhook processing failed');
    }
  }
);

// Helper functions
async function handleSubscriptionUpdate(subscription) {
  const firebaseUID = subscription.metadata.firebaseUID;
  if (!firebaseUID) return;
  
  const tier = subscription.metadata.tier || 'essential';
  const status = subscription.status;
  
  await db.collection('users').doc(firebaseUID).set({
    subscription: {
      stripeSubscriptionId: subscription.id,
      tier: tier,
      status: status,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null
    },
    updatedAt: new Date()
  }, { merge: true });
  
  // Update user claims for access control
  await updateUserClaims(firebaseUID, tier, status);
}

async function handleSubscriptionCancellation(subscription) {
  const firebaseUID = subscription.metadata.firebaseUID;
  if (!firebaseUID) return;
  
  await db.collection('users').doc(firebaseUID).update({
    'subscription.status': 'canceled',
    'subscription.canceledAt': new Date(),
    'subscription.tier': 'free',
    updatedAt: new Date()
  });
  
  await updateUserClaims(firebaseUID, 'free', 'canceled');
}

async function updateUserClaims(uid, tier, status) {
  const admin = await import('firebase-admin/auth');
  
  try {
    await admin.getAuth().setCustomUserClaims(uid, {
      tier: tier,
      subscriptionStatus: status
    });
  } catch (error) {
    console.error('Failed to update user claims:', error);
  }
}

// Check subscription status
export const checkSubscription = onCall(
  { region: "us-east4" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      return { 
        ok: false, 
        tier: 'free',
        status: 'unauthenticated'
      };
    }
    
    try {
      const userDoc = await db.collection('users').doc(uid).get();
      const subscription = userDoc.data()?.subscription;
      
      if (!subscription) {
        return {
          ok: true,
          tier: 'free',
          status: 'no_subscription',
          canAccess: ['symptomPro'] // Free tools
        };
      }
      
      // Check if subscription is active
      const now = new Date();
      const periodEnd = subscription.currentPeriodEnd?.toDate();
      
      if (subscription.status === 'active' || 
          subscription.status === 'trialing' ||
          (subscription.status === 'canceled' && periodEnd > now)) {
        
        const { getToolsForTier } = await import('./toolAccess.js');
        
        return {
          ok: true,
          tier: subscription.tier,
          status: subscription.status,
          canAccess: getToolsForTier(subscription.tier),
          periodEnd: periodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd
        };
      }
      
      return {
        ok: true,
        tier: 'free',
        status: 'expired',
        canAccess: ['symptomPro']
      };
      
    } catch (error) {
      console.error('Subscription check error:', error);
      return {
        ok: false,
        tier: 'free', 
        status: 'error'
      };
    }
  }
);
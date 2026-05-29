    notifyAdmin({
      type: 'SYSTEM_ALERT', // Changed from PAYOUT_NEEDS_APPROVAL to SYSTEM_ALERT
      title: 'New Payout Method Added',
      message: `${method.supplier.name} (${method.supplier.email}) added a new payout method: ${method.type}.`,
      data: {
        supplierId,
        payoutMethodId: method.id,
        type: method.type,
      },
    }).catch((err) => console.error('[AdminNotification] notifyAdmin failed:', err.message));
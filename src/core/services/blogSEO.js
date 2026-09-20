function buildArticleSchema(article) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: article.title,
    description: article.excerpt,
    image: article.featuredImage || undefined,
    datePublished: article.publishedAt ? new Date(article.publishedAt).toISOString() : undefined,
    dateModified: article.updatedAt ? new Date(article.updatedAt).toISOString() : undefined,
    author: article.author ? {
      '@type': 'Person',
      name: article.author.name,
      ...(article.author.photoURL ? { image: article.author.photoURL } : {}),
    } : undefined,
    publisher: {
      '@type': 'Organization',
      name: process.env.BRAND_NAME || 'Travio Africa',
      logo: process.env.LOGO_URL || undefined,
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `${process.env.FRONTEND_URL || 'https://travioafrica.com'}/blog/${article.slug}`,
    },
  };
}

function buildArticleListSchema(articles, totalCount) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: articles.map((a, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: `${process.env.FRONTEND_URL || 'https://travioafrica.com'}/blog/${a.slug}`,
      })),
      numberOfItems: totalCount,
    },
  };
}

module.exports = {
  buildArticleSchema,
  buildArticleListSchema,
};
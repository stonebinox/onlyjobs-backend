import axios from "axios";
import { load } from "cheerio";

// Common interface for all scraped jobs
export interface ScrapedJob {
  title: string;
  company: string;
  location: string;
  description?: string;
  url: string;
  tags?: string[];
  source: string;
  postedAt?: string; // ISO 8601 if available
  scrapedDate?: Date; // Added field for tracking when job was scraped
}

/**
 * Scrapes jobs from WeWorkRemotely
 * HTML-based scraper
 */
export async function scrapeWeWorkRemotely(): Promise<ScrapedJob[]> {
  try {
    const url = "https://weworkremotely.com/categories/remote-programming-jobs";
    const response = await axios.get(url);
    const $ = load(response.data);
    const jobs: ScrapedJob[] = [];

    const jobLinks: {
      title: string;
      company: string;
      location: string;
      url: string;
      tags: string[];
      postedAt?: string;
    }[] = [];

    $("section.jobs li.new-listing-container").each((_, element) => {
      const jobEl = $(element);
      const anchor = jobEl.find("a").eq(1);
      const rawHref = anchor.attr("href") || "";

      // Skip external/ad links
      if (!rawHref.startsWith("/")) {
        console.log("Skipping external/ad link:", rawHref);
        return;
      }

      if (!rawHref.startsWith("/remote-jobs/")) {
        console.log("Skipping non-job link:", rawHref);
        return;
      }

      const jobURL = `https://weworkremotely.com${rawHref}`;
      const title = jobEl.find("h4.new-listing__header__title").text().trim();
      const company = jobEl.find("p.new-listing__company-name").text().trim();
      const location =
        jobEl.find("p.new-listing__company-headquarters").text().trim() ||
        "Remote";

      const tags: string[] = [];
      jobEl.find(".new-listing__categories__category").each((_, el) => {
        const tag = $(el).text().trim();
        if (tag) tags.push(tag);
      });

      const postedAtText = jobEl
        .find(".new-listing__header__icons__date")
        .text()
        .trim();
      let postedAt: string | undefined = undefined;
      if (postedAtText) {
        const now = new Date();
        const daysAgo = parseInt(postedAtText.replace(/[^\d]/g, ""), 10);
        if (!isNaN(daysAgo)) {
          const date = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
          postedAt = date.toISOString();
        }
      }

      if (title && company && jobURL) {
        jobLinks.push({
          title,
          company,
          location,
          url: jobURL,
          tags,
          postedAt,
        });
      }
    });

    // Second pass: fetch each job page to get description
    for (const job of jobLinks) {
      try {
        const jobPage = await axios.get(job.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; JobScraper/1.0)",
          },
        });
        const $$ = load(jobPage.data);

        // Extract and clean description
        const descriptionBlocks: string[] = [];
        $$(".lis-container__job__content__description")
          .find("div, p, li")
          .each((_, el) => {
            const text = $$(el).text().trim();
            if (text) descriptionBlocks.push(text);
          });

        const description = descriptionBlocks.join("\n");

        if (!description) {
          console.warn("Could not find description for:", job.url);
          continue;
        }

        jobs.push({
          ...job,
          description,
          source: "WeWorkRemotely",
          scrapedDate: new Date(),
        });
      } catch (err: any) {
        console.warn(
          "Failed to fetch job description for",
          job.url,
          err.message
        );
      }
    }

    console.log(`Scraped ${jobs.length} jobs from WeWorkRemotely`);
    return jobs;
  } catch (error) {
    console.error("Error scraping WeWorkRemotely:", error);
    return [];
  }
}

/**
 * Scrapes jobs from Remotive
 * JSON API-based scraper (proxied to avoid Cloudflare 526 error)
 */
export async function scrapeRemotive(): Promise<ScrapedJob[]> {
  try {
    const originalUrl =
      "https://remotive.io/api/remote-jobs?category=software-dev";
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(
      originalUrl
    )}`;

    const response = await axios.get(proxyUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; JobBoardScraper/1.0)",
      },
    });

    const data = response.data;

    if (!data.jobs || !Array.isArray(data.jobs)) {
      console.error("Unexpected response format from Remotive API");
      return [];
    }

    const jobs: ScrapedJob[] = data.jobs.map((job: any) => ({
      title: job.title || "Unknown Position",
      company: job.company_name || "Unknown Company",
      location: job.candidate_required_location || "Remote",
      description: job.description,
      url: job.url || job.absolute_url,
      tags: job.tags || [],
      source: "Remotive",
      postedAt: job.publication_date || undefined,
      scrapedDate: new Date(),
    }));

    console.log(`Scraped ${jobs.length} jobs from Remotive`);
    return jobs;
  } catch (error) {
    console.error("Error scraping Remotive:", error);
    return [];
  }
}

/**
 * Scrapes jobs from RemoteOK
 * JSON API-based scraper
 */
export async function scrapeRemoteOK(): Promise<ScrapedJob[]> {
  try {
    // RemoteOK API requires a User-Agent header
    const url = "https://remoteok.com/api";
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; JobBoardScraper/1.0)",
      },
    });

    // The first item is usually not a job but information about the API
    const jobsData = Array.isArray(response.data) ? response.data.slice(1) : [];

    const jobs: ScrapedJob[] = jobsData.map((job: any) => ({
      title: job.position || "Unknown Position",
      company: job.company || "Unknown Company",
      location: job.location || "Remote",
      description: job.description,
      url: `https://remoteok.com${job.url}`,
      tags: job.tags || [],
      source: "RemoteOK",
      postedAt: job.date ? new Date(job.date).toISOString() : undefined,
      scrapedDate: new Date(), // Set the scraped date to the current date
    }));

    console.log(`Scraped ${jobs.length} jobs from RemoteOK`);
    return jobs;
  } catch (error) {
    console.error("Error scraping RemoteOK:", error);
    return [];
  }
}

/**
 * Scrapes jobs from JSRemotely
 * HTML-based scraper
 */
export async function scrapeJSRemotely(): Promise<ScrapedJob[]> {
  try {
    const url = "https://jsremotely.com/remote-javascript-jobs";
    const response = await axios.get(url);
    const $ = load(response.data);
    const jobs: ScrapedJob[] = [];

    // JSRemotely typically has job listings in card-like structures
    $(".job-card, .job-listing, .job-item").each((_, element) => {
      const title = $(element).find(".job-title, h2, h3").first().text().trim();
      const company = $(element)
        .find(".company-name, .company")
        .first()
        .text()
        .trim();
      const locationElement = $(element).find(".location, .job-location");
      const location = locationElement.length
        ? locationElement.text().trim()
        : "Remote";

      // Extract job URL
      const jobURL = $(element).find("a").attr("href") || "";
      const fullURL = jobURL.startsWith("http")
        ? jobURL
        : `https://jsremotely.com${jobURL}`;

      // Extract tags if available
      const tags: string[] = [];
      $(element)
        .find(".tags .tag, .skills span")
        .each((_, tagElement) => {
          tags.push($(tagElement).text().trim());
        });

      // Try to find posted date
      const postedAtText = $(element)
        .find(".date, .posted-date, .job-date")
        .text()
        .trim();
      let postedAt: string | undefined = undefined;

      if (postedAtText) {
        try {
          postedAt = new Date(postedAtText).toISOString();
        } catch (e) {
          // Invalid date format, ignore
        }
      }

      if (title && company && fullURL) {
        jobs.push({
          title,
          company,
          location,
          url: fullURL,
          tags,
          source: "JSRemotely",
          postedAt,
          scrapedDate: new Date(), // Set the scraped date to the current date
        });
      }
    });

    console.log(`Scraped ${jobs.length} jobs from JSRemotely`);
    return jobs;
  } catch (error) {
    console.error("Error scraping JSRemotely:", error);
    return [];
  }
}

/**
 * Scrapes jobs from ReactJobsBoard
 * HTML-based scraper
 */
export async function scrapeReactJobsBoard(): Promise<ScrapedJob[]> {
  try {
    const url = "https://reactjobsboard.com/remote-react-jobs";
    const response = await axios.get(url);
    const $ = load(response.data);
    const jobs: ScrapedJob[] = [];

    // ReactJobsBoard typically has a structure of job cards
    $(".job-card, .job-item, article").each((_, element) => {
      const title = $(element).find(".job-title, h2, h3").first().text().trim();
      const company = $(element)
        .find(".company-name, .company")
        .first()
        .text()
        .trim();
      const location = $(element).find(".location").text().trim() || "Remote";

      // Get job URL
      let jobURL = $(element).find("a").attr("href");
      // Ensure the URL is absolute
      if (jobURL && !jobURL.startsWith("http")) {
        jobURL = `https://reactjobsboard.com${jobURL}`;
      }

      // Extract tags
      const tags: string[] = [];
      $(element)
        .find(".tag, .skill, .technology")
        .each((_, tagEl) => {
          const tag = $(tagEl).text().trim();
          if (tag) tags.push(tag);
        });

      // Extract posted date if available
      const dateText = $(element).find(".date, .posted").text().trim();
      let postedAt: string | undefined = undefined;

      if (dateText) {
        try {
          postedAt = new Date(dateText).toISOString();
        } catch (e) {
          // Invalid date format
        }
      }

      if (title && company && jobURL) {
        jobs.push({
          title,
          company,
          location,
          url: jobURL,
          tags,
          source: "ReactJobsBoard",
          postedAt,
          scrapedDate: new Date(), // Set the scraped date to the current date
        });
      }
    });

    console.log(`Scraped ${jobs.length} jobs from ReactJobsBoard`);
    return jobs;
  } catch (error) {
    console.error("Error scraping ReactJobsBoard:", error);
    return [];
  }
}

/**
 * Scrapes jobs from NoDesk
 * HTML-based scraper
 */
export async function scrapeNoDesk(): Promise<ScrapedJob[]> {
  try {
    const url = "https://nodesk.co/remote-jobs/programming/";
    const response = await axios.get(url);
    const $ = load(response.data);
    const jobs: ScrapedJob[] = [];

    // NoDesk typically displays jobs in a list
    $(".job-listing, .job-item, article").each((_, element) => {
      const titleElement = $(element).find(".job-title, h2, h3").first();
      const title = titleElement.text().trim();
      const company = $(element)
        .find(".company-name, .company")
        .first()
        .text()
        .trim();
      const location =
        $(element).find(".location, .job-location").text().trim() || "Remote";

      // Get job URL
      const jobURL =
        titleElement.find("a").attr("href") ||
        $(element).find("a").attr("href");

      // Some job boards might have tags or categories
      const tags: string[] = [];
      $(element)
        .find(".tags span, .categories span, .skills span")
        .each((_, tagEl) => {
          tags.push($(tagEl).text().trim());
        });

      // Try to extract posting date
      const dateText = $(element).find(".date, .posted-date").text().trim();
      let postedAt: string | undefined = undefined;

      if (dateText) {
        try {
          postedAt = new Date(dateText).toISOString();
        } catch (e) {
          // Invalid date format
        }
      }

      if (title && company && jobURL) {
        jobs.push({
          title,
          company,
          location,
          url: jobURL,
          tags,
          source: "NoDesk",
          postedAt,
          scrapedDate: new Date(), // Set the scraped date to the current date
        });
      }
    });

    console.log(`Scraped ${jobs.length} jobs from NoDesk`);
    return jobs;
  } catch (error) {
    console.error("Error scraping NoDesk:", error);
    return [];
  }
}
